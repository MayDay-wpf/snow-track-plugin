/*
 * Snow App 插件：会话轨迹（com.snow.session-track）
 * renderMode: esm —— 入口作为 ES 模块导入，默认导出 React 组件。
 *
 * 数据来源（全部走 api.metadata 元数据域，不越权读文件）：
 *   - runtime       （live 域，无需声明）焦点会话实时快照：流式指标、TODO、文件改动、子代理、上下文用量
 *   - conversations （plugin.json 已声明）当前项目会话列表：切换会话、模型与累计用量
 *   - messages      （plugin.json 已声明）所选会话的消息记录：还原用户/助手/工具调用时间线
 */

const DOMAIN_IDS = ["runtime", "conversations", "messages"];

const TIMELINE_DEFAULT_VISIBLE = 40;
const TIMELINE_MAX_VISIBLE = 200;
const PREVIEW_LIMIT = 180;
const DETAIL_LIMIT = 4000;

export default function SessionTrackPanel(props) {
  const api = props.api;
  const Snow = typeof window === "undefined" ? null : window.SnowAppPlugin;
  const React = (api && api.ui && api.ui.React) || (Snow && Snow.React);
  if (!React) throw new Error("SnowAppPlugin.React unavailable");
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;

  const [tab, setTab] = useState("trail");
  const [intervalMs, setIntervalMs] = useState(2000);
  const [pinnedId, setPinnedId] = useState(null);
  const [runtimeSnap, setRuntimeSnap] = useState(null);
  const [conversationsSnap, setConversationsSnap] = useState(null);
  const [messagesSnap, setMessagesSnap] = useState(null);
  const [domainList, setDomainList] = useState([]);
  const [deniedScopes, setDeniedScopes] = useState([]);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const tr = useCallback(
    (key, fallback, values) => {
      try {
        return api.t(key, { defaultValue: fallback, values: values || {} });
      } catch (err) {
        return fallback;
      }
    },
    [api],
  );

  /* ---------- 1. 偏好持久化 ---------- */
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.storage.get("intervalMs"))
      .then((saved) => {
        const value = Number(saved);
        if (alive && Number.isFinite(value) && value >= 500) setIntervalMs(value);
      })
      .catch(() => {});
    Promise.resolve()
      .then(() => api.storage.get("pinnedConversationId"))
      .then((saved) => {
        if (alive && typeof saved === "string" && saved) setPinnedId(saved);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const changeInterval = useCallback(
    (value) => {
      setIntervalMs(value);
      Promise.resolve()
        .then(() => api.storage.set("intervalMs", String(value)))
        .catch(() => {});
    },
    [api],
  );

  const changePinned = useCallback(
    (value) => {
      setPinnedId(value);
      Promise.resolve()
        .then(() => api.storage.set("pinnedConversationId", value || ""))
        .catch(() => {});
    },
    [api],
  );

  /* ---------- 2. 域授权自查 ---------- */
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.metadata.domains())
      .then((list) => {
        if (alive && Array.isArray(list)) setDomainList(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  /* ---------- 3. runtime：live 订阅（失败退化为轮询） ---------- */
  useEffect(() => {
    let cancelled = false;
    let sub = null;
    let timer = 0;
    const apply = (snap) => {
      if (!cancelled) setRuntimeSnap(snap);
    };
    const poll = () =>
      Promise.resolve()
        .then(() => api.metadata.get("runtime", {}))
        .then(apply)
        .catch((err) => setError(errText(err)));
    subscribeDomain(api, "runtime", apply, Math.max(1000, intervalMs))
      .then((handle) => {
        if (cancelled) {
          if (handle && typeof handle.unsubscribe === "function") handle.unsubscribe();
          return;
        }
        sub = handle;
      })
      .catch(() => {
        poll();
        timer = setInterval(poll, Math.max(1000, intervalMs));
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (sub && typeof sub.unsubscribe === "function") {
        try {
          sub.unsubscribe();
        } catch (err) {
          /* 忽略 */
        }
      }
    };
  }, [api, intervalMs]);

  /* ---------- 4. conversations：live 订阅 + 低频兜底轮询 ---------- */
  useEffect(() => {
    let cancelled = false;
    let sub = null;
    const apply = (snap) => {
      if (cancelled) return;
      setDeniedScopes(collectDeniedScopes(snap));
      setConversationsSnap(snap);
    };
    const load = () =>
      Promise.resolve()
        .then(() => api.metadata.get("conversations", {}))
        .then(apply)
        .catch(() => {});
    load();
    subscribeDomain(api, "conversations", apply, 10000)
      .then((handle) => {
        if (cancelled) {
          if (handle && typeof handle.unsubscribe === "function") handle.unsubscribe();
          return;
        }
        sub = handle;
      })
      .catch(() => {});
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (sub && typeof sub.unsubscribe === "function") {
        try {
          sub.unsubscribe();
        } catch (err) {
          /* 忽略 */
        }
      }
    };
  }, [api]);

  const runtime = useMemo(() => readRuntime(unwrapDomain(runtimeSnap, "runtime")), [runtimeSnap]);
  const conversations = useMemo(
    () => readConversations(unwrapDomain(conversationsSnap, "conversations")),
    [conversationsSnap],
  );

  const activeId = stringOf(runtime.conversation.conversationId, runtime.conversation.sessionKey);
  const selectedId = pinnedId || activeId;
  const isPinned = Boolean(pinnedId);
  const isFollowing = !isPinned || pinnedId === activeId;

  /* ---------- 5. messages：随所选会话取数 ---------- */
  const messagesRequestRef = useRef("");
  const loadMessages = useCallback(
    (conversationId) => {
      if (!conversationId) {
        setMessagesSnap(null);
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(() => api.metadata.get("messages", { params: { conversationId } }))
        .then((snap) => {
          setDeniedScopes((prev) => mergeScopes(prev, collectDeniedScopes(snap)));
          setMessagesSnap(snap);
        })
        .catch((err) => setError(errText(err)));
    },
    [api],
  );

  useEffect(() => {
    if (!selectedId) {
      messagesRequestRef.current = "";
      setMessagesSnap(null);
      return undefined;
    }
    if (messagesRequestRef.current !== selectedId) {
      messagesRequestRef.current = selectedId;
      setMessagesSnap(null);
      loadMessages(selectedId);
    }
    const period = Math.max(1000, props.isActive === false ? intervalMs * 3 : intervalMs);
    const timer = setInterval(() => loadMessages(selectedId), period);
    return () => clearInterval(timer);
  }, [selectedId, intervalMs, loadMessages, props.isActive]);

  /* ---------- 6. 流式期间的活动计时 ---------- */
  const isLive = runtime.conversation.isStreaming === true && isFollowing;
  useEffect(() => {
    if (!isLive) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isLive]);

  const messages = useMemo(() => readMessages(unwrapDomain(messagesSnap, "messages")), [messagesSnap]);
  const selectedRecord = useMemo(
    () => findConversation(conversations, selectedId),
    [conversations, selectedId],
  );

  /* ---------- 7. 派生视图数据 ---------- */
  const view = useMemo(() => {
    const conversation = isFollowing ? runtime.conversation : {};
    const todos = readTodos(conversation);
    const records = messages.items;
    const trail = buildTrail(records);
    const fileChanges = isFollowing ? readFileChanges(conversation, activeId) : [];
    const subAgents = isFollowing ? readSubAgents(conversation, activeId) : [];
    const events = buildEvents({
      records,
      trail,
      fileChanges,
      subAgents,
      tr,
      now,
    });
    const liveMetrics = readLiveMetrics(conversation, chatInputOf(runtime), now);
    const totals = readTotals(conversation, selectedRecord);
    return {
      conversation,
      todos,
      records,
      trail,
      fileChanges,
      subAgents,
      events,
      liveMetrics,
      totals,
      isStreaming: conversation.isStreaming === true,
      isPaused: conversation.isPaused === true,
      isAborting: conversation.isAborting === true,
      messageCount: num(conversation.messageCount) ?? num(selectedRecord && selectedRecord.messageCount),
    };
  }, [runtime, messages, selectedRecord, isFollowing, activeId, now, tr]);

  /* ---------- 8. 交互 ---------- */
  const refresh = useCallback(() => {
    setError(null);
    return Promise.all([
      Promise.resolve()
        .then(() => api.metadata.get("runtime", {}))
        .then(setRuntimeSnap)
        .catch((err) => setError(errText(err))),
      Promise.resolve()
        .then(() => api.metadata.get("conversations", {}))
        .then(setConversationsSnap)
        .catch(() => {}),
      loadMessages(selectedId),
    ]);
  }, [api, loadMessages, selectedId]);

  const toggleEvent = useCallback((key) => {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }, []);

  const openDiff = useCallback(
    (change) => {
      const patch = change.diff && typeof change.diff.patch === "string" ? change.diff.patch : "";
      if (!patch) return;
      Promise.resolve()
        .then(() =>
          api.write.run("panels.openFileDiff", {
            filePath: change.filePath,
            patch,
            changeType: diffChangeType(change.kind),
          }),
        )
        .then((result) => {
          if (result && result.ok === false) setError(result.error || "openFileDiff failed");
        })
        .catch((err) => setError(errText(err)));
    },
    [api],
  );

  const openFile = useCallback(
    (filePath) => {
      if (!isAbsolutePath(filePath)) return;
      Promise.resolve()
        .then(() => api.write.run("panels.openFile", { filePath }))
        .then((result) => {
          if (result && result.ok === false) setError(result.error || "openFile failed");
        })
        .catch((err) => setError(errText(err)));
    },
    [api],
  );

  const rawPayload = useMemo(() => {
    if (!showRaw) return "";
    try {
      return JSON.stringify(
        {
          selectedConversationId: selectedId,
          pinned: pinnedId,
          runtime: unwrapDomain(runtimeSnap, "runtime"),
          messages: messagesSnap,
          derived: {
            todos: view.todos,
            trail: view.trail,
            fileChanges: view.fileChanges,
            subAgents: view.subAgents,
            totals: view.totals,
          },
          domains: domainList,
        },
        null,
        2,
      );
    } catch (err) {
      return errText(err);
    }
  }, [
    showRaw,
    selectedId,
    pinnedId,
    runtimeSnap,
    messagesSnap,
    view,
    domainList,
  ]);

  const copyRaw = useCallback(() => {
    const payload = showRaw ? rawPayload : JSON.stringify(view, null, 2);
    try {
      const nav = typeof navigator === "undefined" ? null : navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        Promise.resolve(nav.clipboard.writeText(payload)).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }
    } catch (err) {
      /* 忽略 */
    }
  }, [rawPayload, showRaw, view]);

  /* ---------- 9. 渲染 ---------- */
  const statusLabel = view.isStreaming
    ? view.isPaused
      ? tr("status.paused", "已暂停")
      : view.isAborting
        ? tr("status.aborting", "中止中")
        : tr("status.streaming", "流式中")
    : tr("status.idle", "空闲");

  const visibleEvents = showAllEvents
    ? view.events.slice(0, TIMELINE_MAX_VISIBLE)
    : view.events.slice(0, TIMELINE_DEFAULT_VISIBLE);
  const grantedDomains = useMemo(
    () => DOMAIN_IDS.map((id) => ({ id, granted: isDomainGranted(domainList, id) })),
    [domainList],
  );

  return h(
    "div",
    { className: "stk-root" },

    h(
      "div",
      { className: "stk-head" },
      h(
        "div",
        { className: "stk-head-main" },
        h(
          "div",
          { className: "stk-title", title: selectedId || "" },
          stringOf(
            view.conversation.title,
            selectedRecord && selectedRecord.title,
            selectedRecord && selectedRecord.summary,
          ) || tr("title.empty", "无活动会话"),
        ),
        h(
          "div",
          { className: "stk-sub" },
          stringOf(view.conversation.directoryId, selectedRecord && selectedRecord.directoryId)
            ? tr("label.project", "项目") +
                " " +
                shortPath(stringOf(view.conversation.directoryId, selectedRecord.directoryId))
            : tr("label.session", "会话") + " " + (selectedId ? String(selectedId).slice(0, 8) : "—"),
        ),
      ),
      h(
        "div",
        { className: "stk-badges" },
        h(
          "span",
          { className: "stk-badge " + (view.isStreaming ? "stk-badge-live" : "stk-badge-idle") },
          h("i", { className: "stk-dot" }),
          statusLabel,
        ),
        isFollowing
          ? h(
              "span",
              { className: "stk-badge stk-badge-quiet", title: tr("badge.following", "跟随当前会话") },
              icon(api, h, "Radio", 12),
              tr("badge.following", "跟随当前会话"),
            )
          : h(
              "span",
              { className: "stk-badge stk-badge-quiet", title: selectedId || "" },
              icon(api, h, "Pin", 12),
              tr("badge.pinned", "已固定"),
            ),
      ),
    ),

    h(
      "div",
      { className: "stk-select-row" },
      icon(api, h, "MessageSquare", 14),
      h(
        "select",
        {
          className: "stk-select",
          value: pinnedId || "",
          title: tr("select.title", "选择要查看的会话"),
          onChange: (event) => changePinned(event.target.value),
        },
        h("option", { value: "" }, tr("select.follow", "跟随当前会话")),
        conversationOptions(conversations).map((item) =>
          h("option", { key: item.conversationId, value: item.conversationId }, optionLabel(item)),
        ),
      ),
      pinnedId
        ? h(
            "button",
            {
              className: "stk-icon-btn",
              type: "button",
              title: tr("toolbar.follow", "恢复跟随"),
              onClick: () => changePinned(""),
            },
            icon(api, h, "Radio", 14),
          )
        : null,
      h(
        "button",
        {
          className: "stk-icon-btn",
          type: "button",
          title: tr("toolbar.refresh", "立即刷新"),
          onClick: refresh,
        },
        icon(api, h, "RefreshCw", 14),
      ),
    ),

    deniedScopes.length
      ? h(
          "div",
          { className: "stk-note stk-note-warn" },
          icon(api, h, "Ban", 13),
          tr("note.denied", "缺少隐私声明，无法读取：{{scopes}}", {
            scopes: deniedScopes.join(", "),
          }),
        )
      : null,

    view.isStreaming && isFollowing ? liveStrip(api, h, tr, view.liveMetrics) : null,

    h(
      "div",
      { className: "stk-tabs" },
      tabButton(api, h, "trail", "Route", tr("tab.trail", "轨迹"), tab, setTab),
      tabButton(api, h, "data", "ChartColumn", tr("tab.data", "数据"), tab, setTab),
    ),

    tab === "trail"
      ? renderTrail(api, h, tr, {
          view,
          isFollowing,
          visibleEvents,
          showAllEvents,
          expanded,
          toggleEvent,
          openDiff,
          openFile,
          setShowAllEvents,
        })
      : renderData(api, h, tr, {
          view,
          grantedDomains,
          openDiff,
          openFile,
          streamingSessions: runtime.streamingSessions,
          selectedId,
          changePinned,
        }),

    error ? h("div", { className: "stk-error" }, error) : null,

    h(
      "div",
      { className: "stk-toolbar" },
      h(
        "label",
        { className: "stk-field" },
        tr("toolbar.interval", "刷新间隔"),
        h(
          "select",
          {
            className: "stk-select stk-select-mini",
            value: String(intervalMs),
            onChange: (event) => changeInterval(Number(event.target.value) || 2000),
          },
          [1000, 2000, 3000, 5000, 10000].map((option) =>
            h("option", { key: option, value: String(option) }, option + " ms"),
          ),
        ),
      ),
      h(
        "button",
        {
          className: "stk-btn",
          type: "button",
          onClick: () => setShowRaw((prev) => !prev),
        },
        icon(api, h, showRaw ? "Eye" : "Braces", 13),
        showRaw ? tr("section.raw", "原始快照") : tr("raw.hint", "原始快照（可复制用于诊断）"),
      ),
      h(
        "button",
        { className: "stk-btn", type: "button", onClick: copyRaw },
        icon(api, h, "Copy", 13),
        copied ? tr("toolbar.copied", "已复制") : tr("toolbar.copy", "复制快照"),
      ),
    ),

    showRaw
      ? h(
          "pre",
          { className: "stk-pre" },
          rawPayload.length > 40000 ? rawPayload.slice(0, 40000) + "\n…（已截断）" : rawPayload,
        )
      : null,
  );
}

/* ============================ 视图片段 ============================ */

function tabButton(api, h, id, iconName, label, current, setTab) {
  return h(
    "button",
    {
      key: id,
      type: "button",
      className: "stk-tab" + (current === id ? " stk-tab-active" : ""),
      onClick: () => setTab(id),
    },
    icon(api, h, iconName, 14),
    label,
  );
}

function liveStrip(api, h, tr, metrics) {
  const items = [
    { key: "tokens", icon: "Sigma", label: tr("live.tokens", "输出 token"), value: fmtInt(metrics.tokens) },
    { key: "elapsed", icon: "Timer", label: tr("live.elapsed", "耗时"), value: fmtDuration(metrics.elapsedMs) },
    {
      key: "ttft",
      icon: "Zap",
      label: tr("live.ttft", "首字延迟"),
      value: metrics.ttftMs === null ? tr("live.waiting", "等待首个 token…") : fmtDuration(metrics.ttftMs),
    },
    {
      key: "speed",
      icon: "Activity",
      label: tr("live.speed", "速度"),
      value: metrics.tokensPerSecond === null ? "—" : metrics.tokensPerSecond.toFixed(1) + " tok/s",
    },
  ];
  return h(
    "div",
    { className: "stk-live" },
    items.map((item) =>
      h(
        "div",
        { key: item.key, className: "stk-live-cell" },
        h(
          "div",
          { className: "stk-live-label" },
          icon(api, h, item.icon, 12),
          item.label,
        ),
        h("div", { className: "stk-live-value" }, item.value),
      ),
    ),
  );
}

function renderTrail(api, h, tr, ctx) {
  const { view, isFollowing, visibleEvents, showAllEvents, expanded, toggleEvent, openDiff, openFile } = ctx;
  const todos = view.todos;
  const trail = view.trail;

  return h(
    "div",
    { className: "stk-body" },

    !isFollowing
      ? h(
          "div",
          { className: "stk-note" },
          icon(api, h, "Info", 13),
          tr("note.history", "已固定历史会话：TODO、文件改动与实时指标仅对当前活动会话可用。"),
        )
      : null,

    h(
      "div",
      { className: "stk-section" },
      h(
        "div",
        { className: "stk-section-head" },
        h(
          "div",
          { className: "stk-section-title" },
          icon(api, h, "ListChecks", 13),
          tr("section.todos", "TODO 进度"),
        ),
        todos.total
          ? h(
              "span",
              { className: "stk-section-meta" },
              tr("traj.progress", "{{done}}/{{total}} 已完成", {
                done: fmtInt(todos.completed),
                total: fmtInt(todos.total),
              }),
            )
          : null,
      ),
      todos.total
        ? h(
            "div",
            { className: "stk-progress" },
            h("div", {
              className: "stk-progress-fill",
              style: { width: Math.round((todos.completed / todos.total) * 100) + "%" },
            }),
          )
        : null,
      todos.items.length
        ? h(
            "div",
            { className: "stk-todos" },
            todos.rows.map((row) =>
              h(
                "div",
                {
                  key: row.item.id || String(row.index),
                  className: "stk-todo stk-todo-" + row.item.status,
                  style: { paddingLeft: 8 + row.depth * 12 + "px" },
                  title: row.item.content,
                },
                icon(api, h, TODO_ICON[row.item.status] || "CircleDashed", 12),
                h("span", { className: "stk-todo-content" }, row.item.content),
              ),
            ),
          )
        : h("div", { className: "stk-empty" }, tr("empty.todos", "当前会话暂无 TODO 记录")),
    ),

    h(
      "div",
      { className: "stk-section" },
      h(
        "div",
        { className: "stk-section-head" },
        h(
          "div",
          { className: "stk-section-title" },
          icon(api, h, "Waypoints", 13),
          tr("section.timeline", "运行轨迹"),
        ),
        view.events.length
          ? h(
              "span",
              { className: "stk-section-meta" },
              tr("timeline.count", "{{count}} 条记录", { count: fmtInt(view.events.length) }) +
                (trail.total
                  ? " · " +
                    tr("tools.summary", "{{total}} 次 · {{rounds}} 轮", {
                      total: fmtInt(trail.total),
                      rounds: fmtInt(trail.rounds),
                    })
                  : "") +
                (trail.failed
                  ? " · " + tr("tools.failed", "{{count}} 失败", { count: trail.failed })
                  : ""),
            )
          : null,
      ),
      view.events.length
        ? h(
            "div",
            { className: "stk-events" },
            visibleEvents.map((event) =>
              h(
                "div",
                { key: event.key, className: "stk-event stk-event-" + event.kind },
                h(
                  "div",
                  {
                    className: "stk-event-row" + (event.detail ? " stk-event-clickable" : ""),
                    onClick: event.detail ? () => toggleEvent(event.key) : undefined,
                  },
                  h(
                    "span",
                    { className: "stk-event-icon stk-status-" + event.status },
                    icon(api, h, event.icon, 13),
                  ),
                  h(
                    "div",
                    { className: "stk-event-main" },
                    h(
                      "div",
                      { className: "stk-event-head" },
                      h("span", { className: "stk-event-title", title: event.title }, event.title),
                      event.at ? h("span", { className: "stk-event-time" }, fmtTime(event.at)) : null,
                    ),
                    event.meta
                      ? h("div", { className: "stk-event-meta", title: event.meta }, event.meta)
                      : null,
                  ),
                  event.detail
                    ? h(
                        "span",
                        { className: "stk-event-caret" },
                        icon(api, h, expanded[event.key] ? "ChevronDown" : "ChevronRight", 13),
                      )
                    : null,
                ),
                event.actions && event.actions.length
                  ? h(
                      "div",
                      { className: "stk-event-actions" },
                      event.actions.map((action) =>
                        h(
                          "button",
                          {
                            key: action.id,
                            className: "stk-chip-btn",
                            type: "button",
                            onClick: action.run,
                          },
                          action.label,
                        ),
                      ),
                    )
                  : null,
                expanded[event.key] && event.detail
                  ? h("pre", { className: "stk-event-detail" }, event.detail)
                  : null,
              ),
            ),
            view.events.length > TIMELINE_DEFAULT_VISIBLE
              ? h(
                  "button",
                  {
                    className: "stk-btn stk-btn-wide",
                    type: "button",
                    onClick: () => ctx.setShowAllEvents((prev) => !prev),
                  },
                  showAllEvents
                    ? tr("timeline.less", "只看最近 {{count}} 条", {
                        count: TIMELINE_DEFAULT_VISIBLE,
                      })
                    : tr("timeline.more", "展开全部 {{count}} 条", {
                        count: fmtInt(Math.min(view.events.length, TIMELINE_MAX_VISIBLE)),
                      }),
                )
              : null,
          )
        : h("div", { className: "stk-empty" }, tr("empty.timeline", "当前会话暂无运行记录")),
    ),

    view.fileChanges.length
      ? h(
          "div",
          { className: "stk-section" },
          h(
            "div",
            { className: "stk-section-head" },
            h(
              "div",
              { className: "stk-section-title" },
              icon(api, h, "FileText", 13),
              tr("section.files", "文件改动"),
            ),
            h("span", { className: "stk-section-meta" }, String(view.fileChanges.length)),
          ),
          h(
            "div",
            { className: "stk-files" },
            view.fileChanges.slice(0, 40).map((change, index) =>
              h(
                "div",
                { key: change.filePath + "-" + index, className: "stk-file", title: change.filePath },
                h(
                  "span",
                  { className: "stk-file-kind stk-kind-" + change.kind },
                  icon(api, h, FILE_ICON[change.kind] || "FilePen", 12),
                ),
                h("span", { className: "stk-file-path" }, change.filePath),
                change.agent === "sub"
                  ? h("span", { className: "stk-file-tag" }, change.subAgentName || "sub")
                  : null,
                change.diff && change.diff.patch
                  ? h(
                      "button",
                      {
                        className: "stk-chip-btn",
                        type: "button",
                        onClick: () => openDiff(change),
                      },
                      tr("action.diff", "查看改动"),
                    )
                  : null,
                isAbsolutePath(change.filePath)
                  ? h(
                      "button",
                      {
                        className: "stk-chip-btn",
                        type: "button",
                        onClick: () => openFile(change.filePath),
                      },
                      tr("action.openFile", "打开文件"),
                    )
                  : null,
              ),
            ),
          ),
        )
      : null,

    view.subAgents.length
      ? h(
          "div",
          { className: "stk-section" },
          h(
            "div",
            { className: "stk-section-head" },
            h(
              "div",
              { className: "stk-section-title" },
              icon(api, h, "Bot", 13),
              tr("section.subagents", "子代理"),
            ),
            h("span", { className: "stk-section-meta" }, String(view.subAgents.length)),
          ),
          h(
            "div",
            { className: "stk-chips" },
            view.subAgents.map((agent, index) =>
              h(
                "span",
                {
                  key: agent.name + "-" + index,
                  className: "stk-chip" + (agent.status === "running" ? " stk-chip-ok" : ""),
                },
                icon(api, h, "Bot", 12),
                agent.name + " · " + tr("status." + agent.status, agent.status),
              ),
            ),
          ),
        )
      : null,
  );
}

function renderData(api, h, tr, ctx) {
  const { view, grantedDomains, openDiff, openFile, streamingSessions, selectedId, changePinned } = ctx;
  const totals = view.totals;
  const tiles = [
    { key: "messages", icon: "MessageSquare", label: tr("tile.messages", "消息数"), value: fmtInt(view.messageCount) },
    { key: "runOutput", icon: "Sigma", label: tr("tile.runOutput", "本轮输出"), value: fmtInt(totals.runOutput) },
    { key: "duration", icon: "Timer", label: tr("tile.duration", "本轮耗时"), value: fmtDuration(totals.lastRunDurationMs) },
    { key: "ttft", icon: "Zap", label: tr("tile.ttft", "首字延迟"), value: fmtDuration(totals.runTtftMs) },
    { key: "input", icon: "ArrowDownToLine", label: tr("tile.input", "累计输入"), value: fmtInt(totals.input) },
    { key: "output", icon: "ArrowUpFromLine", label: tr("tile.output", "累计输出"), value: fmtInt(totals.output) },
    { key: "cacheRead", icon: "Database", label: tr("tile.cacheRead", "缓存读取"), value: fmtInt(totals.cacheRead) },
    { key: "cacheWrite", icon: "Database", label: tr("tile.cacheWrite", "缓存写入"), value: fmtInt(totals.cacheWrite) },
    { key: "total", icon: "Coins", label: tr("tile.total", "总 Token"), value: fmtInt(totals.total) },
    {
      key: "speed",
      icon: "Activity",
      label: tr("tile.speed", "平均速度"),
      value: totals.averageTokensPerSecond === null ? "—" : totals.averageTokensPerSecond.toFixed(1) + " tok/s",
    },
    { key: "tools", icon: "Wrench", label: tr("tile.tools", "工具调用"), value: fmtInt(view.trail.total) },
    { key: "failed", icon: "CircleAlert", label: tr("tile.failed", "工具失败"), value: fmtInt(view.trail.failed) },
    { key: "files", icon: "FileText", label: tr("tile.files", "文件改动"), value: fmtInt(view.fileChanges.length) },
    { key: "subagents", icon: "Bot", label: tr("tile.subagents", "子代理"), value: fmtInt(view.subAgents.length) },
    { key: "requests", icon: "Repeat", label: tr("tile.requests", "请求轮数"), value: fmtInt(totals.requestCount) },
    { key: "model", icon: "Boxes", label: tr("tile.model", "模型"), value: totals.model || "—" },
  ];

  const context = view.liveMetrics.context;

  return h(
    "div",
    { className: "stk-body" },

    h(
      "div",
      { className: "stk-hero" },
      h(
        "div",
        { className: "stk-hero-top" },
        h(
          "div",
          { className: "stk-hero-label" },
          icon(api, h, "Gauge", 13),
          tr("ctx.label", "上下文占用"),
        ),
        h("span", { className: "stk-hero-value" }, context.percent === null ? "—" : context.percent.toFixed(1) + "%"),
      ),
      h(
        "div",
        { className: "stk-bar" },
        h("div", {
          className:
            "stk-bar-fill" +
            (context.percent !== null && context.percent > 85
              ? " stk-bar-danger"
              : context.percent !== null && context.percent > 60
                ? " stk-bar-warn"
                : ""),
          style: { width: (context.percent === null ? 0 : Math.max(1, Math.min(100, context.percent))) + "%" },
        }),
      ),
      h(
        "div",
        { className: "stk-hero-hint" },
        view.liveMetrics.isLoadingApiConfig
          ? tr("ctx.loading", "API 配置加载中…")
          : context.maxTokens === null
            ? tr("ctx.hint", "上下文窗口未知")
            : tr("ctx.usage", "{{percent}}% · 上限 {{max}}", {
                percent: context.percent === null ? "—" : context.percent.toFixed(1),
                max: fmtInt(context.maxTokens),
              }),
      ),
    ),

    h(
      "div",
      { className: "stk-tiles" },
      tiles.map((tile) =>
        h(
          "div",
          { key: tile.key, className: "stk-tile" },
          h("div", { className: "stk-tile-label" }, icon(api, h, tile.icon, 12), tile.label),
          h("div", { className: "stk-tile-value", title: String(tile.value) }, tile.value),
        ),
      ),
    ),

    streamingSessions.length
      ? h(
          "div",
          { className: "stk-section" },
          h(
            "div",
            { className: "stk-section-head" },
            h(
              "div",
              { className: "stk-section-title" },
              icon(api, h, "Play", 13),
              tr("section.sessions", "运行中的会话"),
            ),
            h("span", { className: "stk-section-meta" }, String(streamingSessions.length)),
          ),
          h(
            "div",
            { className: "stk-sessions" },
            streamingSessions.map((session, index) =>
              h(
                "div",
                {
                  key: session.sessionKey || String(index),
                  className:
                    "stk-session" + (session.conversationId && session.conversationId === selectedId ? " stk-session-active" : ""),
                },
                h(
                  "div",
                  { className: "stk-session-main" },
                  h(
                    "div",
                    { className: "stk-session-title", title: session.title || session.conversationId || "" },
                    session.title || session.conversationId || "—",
                  ),
                  h(
                    "div",
                    { className: "stk-session-meta" },
                    tr("status." + sessionStatus(session), sessionStatus(session)) +
                      " · " +
                      tr("live.tokens", "输出 token") +
                      " " +
                      fmtInt(session.tokenCount) +
                      " · " +
                      fmtDuration(session.elapsedMs),
                  ),
                ),
                session.conversationId
                  ? h(
                      "button",
                      {
                        className: "stk-chip-btn",
                        type: "button",
                        onClick: () => changePinned(session.conversationId),
                      },
                      icon(api, h, "Pin", 12),
                      tr("action.inspect", "查看此会话"),
                    )
                  : null,
              ),
            ),
          ),
        )
      : null,

    h(
      "div",
      { className: "stk-section" },
      h(
        "div",
        { className: "stk-section-head" },
        h(
          "div",
          { className: "stk-section-title" },
          icon(api, h, "FileText", 13),
          tr("section.files", "文件改动"),
        ),
        h("span", { className: "stk-section-meta" }, String(view.fileChanges.length)),
      ),
      view.fileChanges.length
        ? h(
            "div",
            { className: "stk-files" },
            view.fileChanges.slice(0, 60).map((change, index) =>
              h(
                "div",
                { key: change.filePath + "-" + index, className: "stk-file", title: change.filePath },
                h(
                  "span",
                  { className: "stk-file-kind stk-kind-" + change.kind },
                  icon(api, h, FILE_ICON[change.kind] || "FilePen", 12),
                ),
                h("span", { className: "stk-file-path" }, change.filePath),
                change.diff && change.diff.patch
                  ? h(
                      "button",
                      { className: "stk-chip-btn", type: "button", onClick: () => openDiff(change) },
                      tr("action.diff", "查看改动"),
                    )
                  : null,
                isAbsolutePath(change.filePath)
                  ? h(
                      "button",
                      { className: "stk-chip-btn", type: "button", onClick: () => openFile(change.filePath) },
                      tr("action.openFile", "打开文件"),
                    )
                  : null,
              ),
            ),
          )
        : h("div", { className: "stk-empty" }, tr("empty.files", "当前会话暂无文件改动")),
    ),

    h(
      "div",
      { className: "stk-section" },
      h(
        "div",
        { className: "stk-section-head" },
        h(
          "div",
          { className: "stk-section-title" },
          icon(api, h, "Bot", 13),
          tr("section.subagents", "子代理"),
        ),
        h("span", { className: "stk-section-meta" }, String(view.subAgents.length)),
      ),
      view.subAgents.length
        ? h(
            "div",
            { className: "stk-chips" },
            view.subAgents.map((agent, index) =>
              h(
                "span",
                {
                  key: agent.name + "-" + index,
                  className: "stk-chip" + (agent.status === "running" ? " stk-chip-ok" : ""),
                },
                icon(api, h, "Bot", 12),
                agent.name + " · " + tr("status." + agent.status, agent.status),
              ),
            ),
          )
        : h("div", { className: "stk-empty" }, tr("empty.subagents", "当前会话暂无子代理")),
    ),

    h(
      "div",
      { className: "stk-section" },
      h(
        "div",
        { className: "stk-section-head" },
        h(
          "div",
          { className: "stk-section-title" },
          icon(api, h, "Wifi", 13),
          tr("section.domains", "数据权限"),
        ),
      ),
      h(
        "div",
        { className: "stk-chips" },
        grantedDomains.map((item) =>
          h(
            "span",
            {
              key: item.id,
              className: "stk-chip" + (item.granted ? " stk-chip-ok" : " stk-chip-deny"),
            },
            item.granted ? icon(api, h, "Check", 12) : icon(api, h, "Ban", 12),
            item.id,
          ),
        ),
      ),
    ),
  );
}

/* ============================ 图标 ============================ */

function icon(api, h, name, size) {
  const component = api.ui.icon(name);
  if (!component) return null;
  return h(component, { size: size || 13, strokeWidth: 1.8, "aria-hidden": "true" });
}

/* ============================ 常量 ============================ */

const TODO_ICON = {
  completed: "CircleCheck",
  inProgress: "Loader",
  pending: "CircleDashed",
};

const FILE_ICON = {
  create: "FilePlus",
  edit: "FilePen",
  delete: "Trash2",
};

const EVENT_ICON = {
  user: "MessageSquare",
  assistant: "Sparkles",
  tool: "Wrench",
  file: "FileText",
  subagent: "Bot",
};

const ARG_KEYS = [
  "filePath",
  "file_path",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "sql",
  "table",
  "name",
  "tool",
  "subject",
  "message",
  "prompt",
  "content",
];

/* ============================ 通用工具 ============================ */

function isObj(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNum(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const found = num(values[i]);
    if (found !== null) return found;
  }
  return null;
}

function stringOf(...values) {
  for (let i = 0; i < values.length; i += 1) {
    if (typeof values[i] === "string" && values[i]) return values[i];
  }
  return null;
}

function errText(error) {
  if (!error) return "unknown error";
  return error.message ? String(error.message) : String(error);
}

function fmtInt(value) {
  const n = num(value);
  return n === null ? "—" : Math.round(n).toLocaleString("en-US");
}

function fmtDuration(value) {
  const n = num(value);
  if (n === null || n <= 0) return "—";
  if (n < 1000) return Math.round(n) + " ms";
  const seconds = n / 1000;
  if (seconds < 60) return seconds.toFixed(seconds < 10 ? 1 : 0) + " s";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return minutes + "m" + rest + "s";
  const hours = Math.floor(minutes / 60);
  return hours + "h" + (minutes % 60) + "m";
}

function fmtTime(at) {
  const n = num(at);
  if (n === null || n <= 0) return "";
  const date = new Date(n);
  const pad = (value) => String(value).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function flatten(text, limit) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

function shortPath(value) {
  const text = stringOf(value);
  if (!text) return "";
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? text : "…" + "/" + parts.slice(-2).join("/");
}

function isAbsolutePath(filePath) {
  return typeof filePath === "string" && /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(filePath);
}

function diffChangeType(kind) {
  if (kind === "create") return "added";
  if (kind === "delete") return "deleted";
  return "modified";
}

function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/* ============================ 域解析 ============================ */

function pickDomain(payload, id) {
  if (!payload || !isObj(payload)) return null;
  const domains = payload.domains;
  if (!domains) return null;
  if (Array.isArray(domains)) {
    for (let i = 0; i < domains.length; i += 1) {
      const item = domains[i];
      if (isObj(item) && (item.id === id || item.domain === id)) return item;
    }
    return null;
  }
  if (isObj(domains)) return domains[id] === undefined ? null : domains[id];
  return null;
}

function unwrapDomain(payload, id) {
  if (!payload) return null;
  const direct = pickDomain(payload, id);
  return direct === null ? payload : direct;
}

function collectDeniedScopes(payload) {
  if (!payload || !isObj(payload.denied)) return [];
  const out = [];
  const denied = payload.denied;
  Object.keys(denied).forEach((domain) => {
    const entry = denied[domain];
    const scope = isObj(entry) && typeof entry.scope === "string" ? entry.scope : domain;
    if (scope && out.indexOf(scope) === -1) out.push(scope);
  });
  return out;
}

function mergeScopes(prev, next) {
  if (!next.length) return prev;
  const merged = prev.slice();
  next.forEach((scope) => {
    if (merged.indexOf(scope) === -1) merged.push(scope);
  });
  return merged.length === prev.length ? prev : merged;
}

function isDomainGranted(domainList, id) {
  if (!Array.isArray(domainList) || !domainList.length) return true;
  for (let i = 0; i < domainList.length; i += 1) {
    const item = domainList[i];
    if (isObj(item) && (item.id === id || item.domain === id)) return item.granted !== false;
  }
  return true;
}

function readRuntime(payload) {
  const root = isObj(payload) ? payload : {};
  const nested = isObj(root.runtime) ? root.runtime : root;
  return {
    conversation: isObj(nested.conversation) ? nested.conversation : {},
    chatInput: isObj(nested.chatInput) ? nested.chatInput : {},
    streamingSessions: Array.isArray(nested.streamingSessions) ? nested.streamingSessions : [],
  };
}

function chatInputOf(runtime) {
  return isObj(runtime.chatInput) ? runtime.chatInput : {};
}

function readConversations(payload) {
  const root = isObj(payload) ? payload : {};
  const nested = isObj(root.conversations) ? root.conversations : root;
  return {
    items: Array.isArray(nested.items) ? nested.items.filter(isObj) : [],
    pinned: Array.isArray(nested.pinned) ? nested.pinned.filter(isObj) : [],
  };
}

function readMessages(payload) {
  const root = isObj(payload) ? payload : {};
  const nested = isObj(root.messages) ? root.messages : root;
  const items = Array.isArray(nested.items) ? nested.items.filter(isObj) : [];
  return { items };
}

function findConversation(conversations, conversationId) {
  if (!conversationId) return null;
  const pool = conversations.items.concat(conversations.pinned);
  for (let i = 0; i < pool.length; i += 1) {
    if (pool[i].conversationId === conversationId) return pool[i];
  }
  return null;
}

function conversationOptions(conversations) {
  const seen = {};
  const out = [];
  const push = (item) => {
    const id = stringOf(item.conversationId);
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push(item);
  };
  conversations.pinned.forEach(push);
  conversations.items.forEach(push);
  return out;
}

function optionLabel(item) {
  const title = stringOf(item.title, item.summary, item.lastMessagePreview) || item.conversationId;
  const kind = stringOf(item.conversationType);
  return kind === "subAgent" ? "  " + title : title;
}

/** subscribe 在新版宿主返回 Promise，旧版可能同步返回；统一成 Promise。 */
function subscribeDomain(api, domain, listener, intervalMs) {
  try {
    const options = intervalMs ? { intervalMs } : {};
    const result = api.metadata.subscribe(domain, listener, options);
    return result && typeof result.then === "function" ? result : Promise.resolve(result);
  } catch (err) {
    return Promise.reject(err);
  }
}

/* ============================ 派生数据 ============================ */

function readTodos(conversation) {
  const empty = { items: [], rows: [], total: 0, completed: 0, incomplete: 0 };
  const raw = conversation && conversation.todos;
  if (!isObj(raw)) return empty;
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter(isObj)
        .map((item) => ({
          id: stringOf(item.id) || "",
          content: stringOf(item.content) || "",
          status: item.status === "completed" || item.status === "inProgress" ? item.status : "pending",
          parentId: stringOf(item.parentId),
        }))
    : [];
  if (!items.length) return empty;
  const byId = new Map();
  items.forEach((item) => {
    if (item.id) byId.set(item.id, item);
  });
  const rows = items.map((item, index) => {
    let depth = 0;
    let cursor = item;
    while (cursor && cursor.parentId && depth < 4) {
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      cursor = parent;
      depth += 1;
    }
    return { item, index, depth };
  });
  const total = firstNum(raw.totalCount, items.length);
  const completed = firstNum(raw.completedCount, items.filter((item) => item.status === "completed").length);
  return { items, rows, total, completed, incomplete: total - completed };
}

function readLiveMetrics(conversation, chatInput, now) {
  const startedAt = firstNum(conversation.streamStartedAt);
  const elapsedFromBackend = firstNum(conversation.streamElapsedMs);
  const elapsedMs =
    conversation.isStreaming === true && startedAt !== null && startedAt > 0
      ? Math.max(now - startedAt, elapsedFromBackend || 0)
      : elapsedFromBackend || 0;
  const tokens = firstNum(conversation.streamTokenCount) || 0;
  const ttftMs = firstNum(conversation.streamTtftMs);
  const tokensPerSecond = elapsedMs > 0 && tokens > 0 ? (tokens / elapsedMs) * 1000 : null;
  const usage = readTokenUsage(conversation.tokenUsage);
  const total = usage ? usage.total : null;
  const maxTokens = firstNum(chatInput.maxContextTokens);
  const percent =
    total !== null && maxTokens !== null && maxTokens > 0 ? Math.min((total / maxTokens) * 100, 100) : null;
  return {
    tokens,
    elapsedMs,
    ttftMs: ttftMs !== null && ttftMs > 0 ? ttftMs : null,
    tokensPerSecond,
    isLoadingApiConfig: chatInput.isLoadingApiConfig === true,
    context: { total, maxTokens, percent },
  };
}

function readTotals(conversation, record) {
  const conversationUsage = readTokenUsage(conversation.tokenUsage);
  const runUsage = readTokenUsage(conversation.runTokenUsage);
  const recordInput = firstNum(record && record.inputTokens);
  const recordOutput = firstNum(record && record.outputTokens);
  const input = conversationUsage && conversationUsage.input !== null ? conversationUsage.input : recordInput;
  const output = conversationUsage && conversationUsage.output !== null ? conversationUsage.output : recordOutput;
  const cacheRead =
    conversationUsage && conversationUsage.cacheRead !== null
      ? conversationUsage.cacheRead
      : firstNum(record && record.cacheReadInputTokens);
  const cacheWrite =
    conversationUsage && conversationUsage.cacheCreation !== null
      ? conversationUsage.cacheCreation
      : firstNum(record && record.cacheCreationInputTokens);
  const total = input === null && output === null ? null : (input || 0) + (output || 0);
  const duration = firstNum(conversation.lastRunDurationMs, record && record.lastRunDurationMs);
  const runOutput = runUsage ? runUsage.output : null;
  const ttftSum = firstNum(record && record.runTtftSumMs);
  const requestCount = firstNum(record && record.runRequestCount);
  const runTtftMs =
    firstNum(conversation.runTtftMs) !== null
      ? firstNum(conversation.runTtftMs)
      : ttftSum !== null && requestCount
        ? ttftSum / requestCount
        : ttftSum;
  const averageTokensPerSecond =
    duration !== null && duration > 0 && runOutput !== null && runOutput > 0
      ? (runOutput / duration) * 1000
      : null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    runOutput,
    lastRunDurationMs: duration,
    runTtftMs,
    requestCount,
    model: stringOf(record && record.model, conversation.model),
    averageTokensPerSecond,
  };
}

function readTokenUsage(raw) {
  if (!isObj(raw)) return null;
  const input = firstNum(raw.inputTokens, raw.input_tokens, raw.promptTokens);
  const output = firstNum(raw.outputTokens, raw.output_tokens, raw.completionTokens);
  const cacheCreation = firstNum(raw.cacheCreationInputTokens, raw.cache_creation_input_tokens);
  const cacheRead = firstNum(raw.cacheReadInputTokens, raw.cache_read_input_tokens, raw.cachedTokens);
  const explicit = firstNum(raw.totalTokens, raw.total_tokens, raw.total);
  const total = explicit !== null ? explicit : input === null && output === null ? null : (input || 0) + (output || 0);
  if (total === null && input === null && output === null && cacheRead === null) return null;
  return { input, output, cacheCreation, cacheRead, total };
}

function readFileChanges(conversation, conversationId) {
  const raw = conversation && conversation.fileChangeStats;
  if (!isObj(raw)) return [];
  let list = conversationId && Array.isArray(raw[conversationId]) ? raw[conversationId] : null;
  if (!list) {
    list = [];
    Object.keys(raw).forEach((key) => {
      if (Array.isArray(raw[key])) list = list.concat(raw[key]);
    });
  }
  const latest = new Map();
  list.forEach((change) => {
    if (!isObj(change) || !stringOf(change.filePath)) return;
    const existing = latest.get(change.filePath);
    if (!existing || (num(change.timestamp) || 0) >= (num(existing.timestamp) || 0)) {
      latest.set(change.filePath, {
        filePath: change.filePath,
        kind: stringOf(change.kind) || "edit",
        agent: stringOf(change.agent) || "main",
        subAgentName: stringOf(change.subAgentName),
        timestamp: num(change.timestamp) || 0,
        diff: isObj(change.diff) ? change.diff : null,
      });
    }
  });
  const out = [];
  latest.forEach((value) => out.push(value));
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

function readSubAgents(conversation, conversationId) {
  const raw = conversation && conversation.subAgentSessions;
  if (!isObj(raw)) return [];
  const out = [];
  Object.keys(raw).forEach((key) => {
    const event = raw[key];
    if (!isObj(event)) return;
    const parent = stringOf(event.parentConversationId);
    if (conversationId && parent && parent !== conversationId && key !== conversationId) return;
    out.push({
      name: stringOf(event.agentName, event.agentId) || key,
      status: stringOf(event.status) || "running",
      at: num(event.timestamp) || 0,
    });
  });
  out.sort((a, b) => b.at - a.at);
  return out;
}

function sessionStatus(session) {
  if (session.isAborting === true) return "aborting";
  if (session.isPaused === true) return "paused";
  if (session.isStreaming === true) return "streaming";
  return "idle";
}

/* ============================ 轨迹构建 ============================ */

function normalizeToolName(name) {
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  return colon > 0 ? trimmed.slice(0, colon) : trimmed;
}

function readToolName(call) {
  const direct = stringOf(call.name, call.tool_name, call.toolName);
  if (direct) return normalizeToolName(direct);
  const nested = isObj(call.function)
    ? call.function
    : isObj(call.function_call)
      ? call.function_call
      : isObj(call.functionCall)
        ? call.functionCall
        : null;
  if (nested) {
    const inner = stringOf(nested.name, nested.tool_name, nested.toolName);
    if (inner) return normalizeToolName(inner);
  }
  return null;
}

function readToolCallId(call) {
  const readFrom = (record) => stringOf(record.call_id, record.callId, record.id);
  const direct = readFrom(call);
  if (direct) return direct;
  const nested = isObj(call.function_call)
    ? call.function_call
    : isObj(call.functionCall)
      ? call.functionCall
      : isObj(call.function)
        ? call.function
        : null;
  return nested ? readFrom(nested) : null;
}

function readToolArguments(call) {
  const candidates = [
    call.arguments,
    call.args,
    call.input,
    call.argumentsJson,
    isObj(call.function) ? call.function.arguments : null,
    isObj(call.functionCall) ? call.functionCall.args : null,
    isObj(call.functionCall) ? call.functionCall.arguments : null,
    isObj(call.function_call) ? call.function_call.args : null,
    isObj(call.function_call) ? call.function_call.arguments : null,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (typeof candidate === "string" && candidate.trim() && candidate.trim() !== "{}") return candidate;
    if (isObj(candidate) && Object.keys(candidate).length) return JSON.stringify(candidate);
  }
  return "";
}

function parseToolCallsRaw(json) {
  if (typeof json !== "string" || !json.trim()) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const calls = [];
  parsed.forEach((entry) => {
    if (!isObj(entry)) return;
    const name = readToolName(entry);
    if (!name) return;
    calls.push({ name, callId: readToolCallId(entry), arguments: readToolArguments(entry) });
  });
  return calls;
}

function summarizeArgs(argsJson) {
  const raw = typeof argsJson === "string" ? argsJson.trim() : "";
  if (!raw || raw === "{}") return "";
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    parsed = null;
  }
  if (isObj(parsed)) {
    for (let i = 0; i < ARG_KEYS.length; i += 1) {
      const value = parsed[ARG_KEYS[i]];
      if (typeof value === "string" && value.trim()) return flatten(value, 140);
      if (typeof value === "number") return ARG_KEYS[i] + "=" + value;
    }
    return Object.keys(parsed)
      .slice(0, 3)
      .map((key) => key + "=" + shortValue(parsed[key]))
      .join(", ");
  }
  if (Array.isArray(parsed)) return "[" + parsed.length + " items]";
  if (typeof parsed === "string") return flatten(parsed, 140);
  return flatten(raw.replace(/^\{|\}$/g, ""), 140);
}

function shortValue(value) {
  if (typeof value === "string") return flatten(value, 40);
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return Array.isArray(value) ? "[" + value.length + "]" : "{…}";
  return String(value);
}

function previewText(text, limit) {
  if (typeof text !== "string" || !text.trim()) return "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line) return flatten(line, limit);
  }
  return "";
}

function resultStatus(text) {
  if (typeof text !== "string" || !text.trim()) return "pending";
  const trimmed = text.trim();
  if (trimmed.charAt(0) === "{") {
    try {
      const parsed = JSON.parse(trimmed);
      if (isObj(parsed)) {
        if (parsed.success === false) return "error";
        if (typeof parsed.error === "string" && parsed.error.trim()) return "error";
        if (parsed.error === true) return "error";
        if (typeof parsed.status === "string" && /error|fail|失败/i.test(parsed.status)) return "error";
      }
    } catch (err) {
      /* 保持后续启发式判断 */
    }
  }
  if (/^(Error|错误)\b|^Error:|Tool execution failed|工具执行失败/i.test(trimmed)) return "error";
  return "done";
}

/** 还原工具调用轨迹：assistant.toolCallsJson -> 调用；role=tool 的 `[Tool: name#callId]` 分段 -> 结果。 */
function buildTrail(records) {
  const list = Array.isArray(records) ? records : [];
  const queues = new Map();
  list.forEach((record) => {
    if (!isObj(record) || record.role !== "tool" || typeof record.content !== "string") return;
    record.content.split("\n\n").forEach((segment) => {
      const match = segment.match(/^\[Tool:\s*(.+?)\]\n([\s\S]*)$/);
      if (!match) return;
      const key = match[1].trim();
      const queue = queues.get(key) || [];
      queue.push(match[2]);
      queues.set(key, queue);
    });
  });

  const take = (name, callId) => {
    const identifiers = callId ? [name + "#" + callId, name] : [name];
    for (let i = 0; i < identifiers.length; i += 1) {
      const queue = queues.get(identifiers[i]);
      if (queue && queue.length) return queue.shift();
    }
    return undefined;
  };

  const steps = [];
  let round = 0;
  let failed = 0;
  let pending = 0;
  list.forEach((record, recordIndex) => {
    if (!isObj(record)) return;
    const calls = parseToolCallsRaw(record.toolCallsJson);
    if (!calls.length) return;
    round += 1;
    calls.forEach((call, callIndex) => {
      const result = take(call.name, call.callId);
      const status = resultStatus(result);
      if (status === "error") failed += 1;
      if (status === "pending") pending += 1;
      steps.push({
        key: (stringOf(record.id) || "m" + recordIndex) + "-" + callIndex,
        recordId: stringOf(record.id) || "m" + recordIndex,
        round,
        name: call.name,
        args: summarizeArgs(call.arguments),
        argsRaw: call.arguments,
        result: previewText(result, PREVIEW_LIMIT),
        resultRaw: typeof result === "string" ? result : "",
        status,
        at: toMs(record.createdAt),
      });
    });
  });

  return { steps, rounds: round, total: steps.length, failed, pending };
}

function buildEvents({ records, trail, fileChanges, subAgents, tr, now }) {
  const events = [];
  const stepsByRecord = new Map();
  trail.steps.forEach((step) => {
    const bucket = stepsByRecord.get(step.recordId) || [];
    bucket.push(step);
    stepsByRecord.set(step.recordId, bucket);
  });

  records.forEach((record, index) => {
    const at = toMs(record.createdAt) || now;
    const recordId = stringOf(record.id) || "m" + index;
    if (record.role === "user") {
      const content = typeof record.content === "string" ? record.content : "";
      events.push({
        key: "u-" + recordId,
        kind: "user",
        icon: EVENT_ICON.user,
        status: "done",
        at,
        title: previewText(content, PREVIEW_LIMIT) || tr("ev.user", "用户"),
        meta: "",
        detail: content.length > PREVIEW_LIMIT ? content.slice(0, DETAIL_LIMIT) : "",
      });
      return;
    }
    if (record.role === "assistant") {
      const content = typeof record.content === "string" ? record.content : "";
      const thinking = typeof record.thinking === "string" ? record.thinking : "";
      const thinkingTokens = firstNum(record.thinkingTokenCount);
      const thinkingDuration = firstNum(record.thinkingDurationMs);
      const usage = readTokenUsage(record);
      const metaParts = [];
      if (thinking && (thinkingDuration !== null || thinkingTokens !== null)) {
        metaParts.push(
          tr("ev.thinking", "思考 {{duration}} · {{tokens}} tok", {
            duration: fmtDuration(thinkingDuration),
            tokens: fmtInt(thinkingTokens),
          }),
        );
      }
      if (usage && (usage.input !== null || usage.output !== null)) {
        metaParts.push(
          tr("ev.tokens", "{{input}} 入 / {{output}} 出", {
            input: fmtInt(usage.input),
            output: fmtInt(usage.output),
          }),
        );
      }
      const detailParts = [];
      if (thinking) detailParts.push(thinking.slice(0, DETAIL_LIMIT));
      if (content) detailParts.push(content.slice(0, DETAIL_LIMIT));
      events.push({
        key: "a-" + recordId,
        kind: "assistant",
        icon: EVENT_ICON.assistant,
        status: record.status === "error" ? "error" : "done",
        at,
        title: previewText(content, PREVIEW_LIMIT) || tr("ev.assistant", "助手"),
        meta: metaParts.join(" · "),
        detail: detailParts.join("\n\n---\n\n"),
      });

      const steps = stepsByRecord.get(recordId) || [];
      steps.forEach((step) => {
        const detailParts = [];
        if (step.argsRaw) detailParts.push(tr("ev.args", "参数") + ":\n" + step.argsRaw);
        if (step.resultRaw) detailParts.push(tr("ev.result", "结果") + ":\n" + step.resultRaw);
        events.push({
          key: "t-" + step.key,
          kind: "tool",
          icon: EVENT_ICON.tool,
          status: step.status,
          at,
          title: step.name + (step.args ? "  " + step.args : ""),
          meta: tr("ev.round", "第 {{round}} 轮", { round: step.round }) + (step.result ? " · " + step.result : ""),
          detail: detailParts.join("\n\n").slice(0, DETAIL_LIMIT),
        });
      });
    }
  });

  fileChanges.forEach((change, index) => {
    events.push({
      key: "f-" + change.filePath + "-" + index,
      kind: "file",
      icon: EVENT_ICON.file,
      status: change.kind === "delete" ? "error" : "done",
      at: change.timestamp || 0,
      title:
        (change.kind === "create"
          ? tr("file.create", "新建")
          : change.kind === "delete"
            ? tr("file.delete", "删除")
            : tr("file.edit", "修改")) + "  " + change.filePath,
      meta: change.agent === "sub" ? (change.subAgentName || "sub") + " · " + tr("ev.file", "文件") : tr("ev.file", "文件"),
      detail: change.diff && typeof change.diff.patch === "string" ? change.diff.patch.slice(0, DETAIL_LIMIT) : "",
    });
  });

  subAgents.forEach((agent, index) => {
    events.push({
      key: "s-" + agent.name + "-" + index,
      kind: "subagent",
      icon: EVENT_ICON.subagent,
      status: agent.status === "failed" ? "error" : agent.status === "running" ? "pending" : "done",
      at: agent.at || 0,
      title: agent.name,
      meta: tr("ev.subagent", "子代理") + " · " + tr("status." + agent.status, agent.status),
      detail: "",
    });
  });

  events.sort((a, b) => (b.at || 0) - (a.at || 0));
  return events;
}
