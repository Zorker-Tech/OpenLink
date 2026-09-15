'use client';
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { projectMessageRevisions } from "../lib/agent-runtime/message-revisions.js";
import { agentErrorTitle, groupAgentErrorRecords } from "../lib/agent-runtime/error-groups.js";
import { useRef } from 'react';
import { Conversation, ConversationContent, } from "./ai-elements/conversation.js";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message.js";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./ai-elements/reasoning.js";
import { Task, TaskContent, TaskTrigger } from "./ai-elements/task.js";
import { ChatCodePreview } from "./chat-code-preview.js";
import { ThinkingOrb } from "./thinking/src/index.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, } from "./ui/dropdown-menu.js";
import { Atom, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, Copy, FileText, Link2, MoreHorizontal, RefreshCw, RotateCcw, } from 'lucide-react';
import { HugeiconsIcon } from '@hugeicons/react';
import { AiBrain02Icon, BadgeCheckIcon, BookOpen01Icon, Edit01Icon, SquareTerminalIcon } from '@hugeicons/core-free-icons';
import { useEffect, useId, useMemo, useState } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
function replaceItem(items, id, update) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0)
        return [...items, update(undefined)];
    const next = items.slice();
    next[index] = update(next[index]);
    return next;
}
function taskState(executions, fallback) {
    if (executions.some((execution) => execution.state === 'active'))
        return 'active';
    if (executions.some((execution) => execution.state === 'failed'))
        return 'failed';
    if (executions.length > 0 && executions.every((execution) => execution.state === 'completed'))
        return 'completed';
    if (executions.some((execution) => execution.state === 'pending'))
        return 'pending';
    return fallback;
}
function humanizeToolName(name) {
    return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
function fallbackTaskLabel(execution) {
    if (execution.kind === 'command')
        return 'Run command';
    const name = execution.label.toLowerCase();
    if (/read|open/.test(name))
        return 'Read files';
    if (/search|find|grep/.test(name))
        return 'Search project';
    if (/edit|write|patch/.test(name))
        return 'Update files';
    if (/fetch|web|http|browser/.test(name))
        return 'Fetch resources';
    return humanizeToolName(execution.label);
}
function taskIdForRound(state, taskId) {
    // Older persisted events used a per-request `session:task:0` id. Since the
    // adapter was recreated for every request, that id recurred in each round
    // and collapsed every subsequent task into the first visible Working group.
    // Scope task ids locally by the preceding user message to keep legacy
    // histories correct as well as new streams.
    return state.activeRoundId ? `${state.activeRoundId}:task:${taskId}` : taskId;
}
function resolveStartedTaskId(state, event) {
    if (event.taskId) {
        const taskId = taskIdForRound(state, event.taskId);
        state.activeExecutionTaskId = taskId;
        state.lastExecutionStartedAt = Date.parse(event.timestamp);
        if (event.partId)
            state.partTaskIds[event.partId] = taskId;
        return taskId;
    }
    if (event.partId && state.partTaskIds[event.partId])
        return state.partTaskIds[event.partId];
    const startedAt = Date.parse(event.timestamp);
    const withinBurst = state.activeExecutionTaskId
        && state.lastExecutionStartedAt !== undefined
        && Number.isFinite(startedAt)
        && startedAt >= state.lastExecutionStartedAt
        && startedAt - state.lastExecutionStartedAt <= 5_000;
    const taskId = withinBurst
        ? state.activeExecutionTaskId
        : `${event.sessionId}:auto-task:${event.sequence}`;
    state.activeExecutionTaskId = taskId;
    state.lastExecutionStartedAt = startedAt;
    if (event.partId)
        state.partTaskIds[event.partId] = taskId;
    return taskId;
}
function findExecutionTaskId(items, executionId) {
    return items.find((item) => item.kind === 'task' && item.executions.some((execution) => execution.id === executionId))?.id;
}
function upsertTaskExecution(state, taskId, execution, fallbackLabel = fallbackTaskLabel(execution)) {
    state.items = replaceItem(state.items, taskId, (current) => {
        const task = current?.kind === 'task'
            ? current
            : { id: taskId, kind: 'task', label: fallbackLabel, state: execution.state, executions: [] };
        const index = task.executions.findIndex((item) => item.id === execution.id);
        const executions = task.executions.slice();
        if (index < 0)
            executions.push(execution);
        else
            executions[index] = { ...executions[index], ...execution };
        return { ...task, state: taskState(executions, task.state), executions };
    });
}
function updateTaskExecution(state, executionId, scope, update) {
    const taskId = scope.taskId
        ? taskIdForRound(state, scope.taskId)
        : findExecutionTaskId(state.items, executionId);
    if (!taskId)
        return;
    state.items = replaceItem(state.items, taskId, (current) => {
        const task = current?.kind === 'task'
            ? current
            : { id: taskId, kind: 'task', label: 'Agent task', state: 'active', executions: [] };
        const index = task.executions.findIndex((execution) => execution.id === executionId);
        const existing = index >= 0 ? task.executions[index] : undefined;
        const nextExecution = update(existing);
        const executions = task.executions.slice();
        if (index < 0)
            executions.push(nextExecution);
        else
            executions[index] = nextExecution;
        return { ...task, state: taskState(executions, task.state), executions };
    });
}
function buildTimeline(events) {
    return events.reduce((state, event) => {
        state.source = event.source;
        switch (event.type) {
            case 'session.started':
                state.status = 'running';
                break;
            case 'session.completed':
                state.status = 'settled';
                break;
            case 'message.user':
                // A user message begins a new durable turn. Reset transient grouping
                // state before processing following tool frames, including when this
                // is a historical replay after reopening a session.
                state.activeRoundId = event.messageId;
                state.activeExecutionTaskId = undefined;
                state.lastExecutionStartedAt = undefined;
                state.partTaskIds = {};
                state.items = replaceItem(state.items, event.messageId, () => ({ id: event.messageId, kind: 'message', role: 'user', text: event.text, attachments: event.attachments, streaming: false }));
                break;
            case 'message.delta':
                if (!state.items.some((item) => item.kind === 'message' && item.id === event.messageId)) {
                    state.activeExecutionTaskId = undefined;
                    state.lastExecutionStartedAt = undefined;
                    state.partTaskIds = {};
                }
                state.items = replaceItem(state.items, event.messageId, (current) => ({
                    id: event.messageId,
                    kind: 'message',
                    role: 'assistant',
                    text: current?.kind === 'message' ? current.text + event.delta : event.delta,
                    streaming: true,
                }));
                break;
            case 'message.completed':
                state.items = replaceItem(state.items, event.messageId, (current) => ({
                    id: event.messageId,
                    kind: 'message',
                    role: 'assistant',
                    text: event.text ?? (current?.kind === 'message' ? current.text : ''),
                    streaming: false,
                }));
                break;
            case 'reasoning.started':
                state.items = replaceItem(state.items, event.reasoningId, () => ({ id: event.reasoningId, kind: 'reasoning', text: '', streaming: true }));
                break;
            case 'reasoning.delta':
                state.items = replaceItem(state.items, event.reasoningId, (current) => ({
                    id: event.reasoningId,
                    kind: 'reasoning',
                    text: current?.kind === 'reasoning' ? current.text + event.delta : event.delta,
                    streaming: true,
                }));
                break;
            case 'reasoning.completed':
                state.items = replaceItem(state.items, event.reasoningId, (current) => ({
                    id: event.reasoningId,
                    kind: 'reasoning',
                    text: event.text ?? (current?.kind === 'reasoning' ? current.text : ''),
                    streaming: false,
                    durationMs: event.durationMs,
                }));
                break;
            case 'command.started': {
                const taskId = resolveStartedTaskId(state, event);
                upsertTaskExecution(state, taskId, { id: event.commandId, kind: 'command', label: 'Run', input: { command: event.command }, state: 'active' });
                break;
            }
            case 'command.output':
                updateTaskExecution(state, event.commandId, event, (current) => ({ id: event.commandId, kind: 'command', label: current?.label ?? 'Run', input: current?.input, output: event.output, state: 'active' }));
                break;
            case 'command.completed':
                updateTaskExecution(state, event.commandId, event, (current) => ({ id: event.commandId, kind: 'command', label: current?.label ?? 'Run', input: current?.input, output: event.output ?? current?.output, state: event.exitCode && event.exitCode !== 0 ? 'failed' : 'completed' }));
                break;
            case 'file.editing.started': {
                const taskId = resolveStartedTaskId(state, event);
                upsertTaskExecution(state, taskId, {
                    id: event.editId,
                    kind: 'file',
                    label: event.operation,
                    input: { path: event.path },
                    path: event.path,
                    language: event.language,
                    content: event.content,
                    operation: event.operation,
                    editState: 'editing',
                    state: 'active',
                });
                break;
            }
            case 'file.editing.updated':
                updateTaskExecution(state, event.editId, event, (current) => ({
                    id: event.editId,
                    kind: 'file',
                    label: current?.label ?? event.operation,
                    input: current?.input ?? { path: event.path },
                    path: event.path,
                    language: event.language ?? current?.language,
                    content: event.content ?? current?.content,
                    operation: event.operation,
                    editState: 'editing',
                    state: 'active',
                }));
                break;
            case 'file.editing.completed':
                updateTaskExecution(state, event.editId, event, (current) => ({
                    id: event.editId,
                    kind: 'file',
                    label: current?.label ?? event.operation,
                    input: current?.input ?? { path: event.path },
                    path: event.path,
                    language: event.language ?? current?.language,
                    content: event.content ?? current?.content,
                    operation: event.operation,
                    editState: 'edited',
                    state: 'completed',
                }));
                break;
            case 'file.editing.failed':
                updateTaskExecution(state, event.editId, event, (current) => ({
                    id: event.editId,
                    kind: 'file',
                    label: current?.label ?? event.operation,
                    input: current?.input ?? { path: event.path },
                    path: event.path,
                    language: event.language ?? current?.language,
                    content: event.content ?? current?.content,
                    operation: event.operation,
                    editState: 'failed',
                    state: 'failed',
                    error: event.error,
                }));
                break;
            case 'tool.started': {
                const taskId = resolveStartedTaskId(state, event);
                upsertTaskExecution(state, taskId, { id: event.toolId, kind: 'tool', label: event.name, input: event.input, state: 'active' });
                break;
            }
            case 'tool.output':
                updateTaskExecution(state, event.toolId, event, (current) => ({ id: event.toolId, kind: 'tool', label: current?.label ?? 'Tool', input: current?.input, output: event.output, state: 'active' }));
                break;
            case 'tool.completed':
            case 'tool.failed':
                updateTaskExecution(state, event.toolId, event, (current) => ({
                    id: event.toolId,
                    kind: 'tool',
                    label: current?.label ?? 'Tool',
                    input: current?.input,
                    output: event.type === 'tool.completed' ? event.output ?? current?.output : current?.output,
                    error: event.type === 'tool.failed' ? event.error : undefined,
                    state: event.type === 'tool.failed' ? 'failed' : 'completed',
                }));
                break;
            case 'file.changed':
                state.items = replaceItem(state.items, event.changeId, () => ({ id: event.changeId, kind: 'change', label: event.label, additions: event.additions, deletions: event.deletions, files: event.files, snapshot: event.snapshot, baseCommit: event.baseCommit }));
                break;
            case 'task.updated':
                {
                    const taskId = taskIdForRound(state, event.taskId);
                    state.items = replaceItem(state.items, taskId, (current) => {
                        const executions = current?.kind === 'task' ? current.executions : [];
                        return { id: taskId, kind: 'task', label: event.label, detail: event.detail, state: taskState(executions, event.status), executions };
                    });
                    state.activeExecutionTaskId = taskId;
                    state.lastExecutionStartedAt = Date.parse(event.timestamp);
                }
                break;
            case 'status.updated':
                state.items = replaceItem(state.items, event.statusId, () => ({ id: event.statusId, kind: 'status', label: event.label, detail: event.detail, state: event.status }));
                break;
            case 'confirmation.requested':
                state.items = replaceItem(state.items, event.confirmationId, () => ({ id: event.confirmationId, kind: 'confirmation', title: event.title, message: event.message, options: event.options }));
                break;
            case 'confirmation.resolved':
                state.items = replaceItem(state.items, event.confirmationId, (current) => ({ id: event.confirmationId, kind: 'confirmation', title: current?.kind === 'confirmation' ? current.title : 'Confirmation', message: current?.kind === 'confirmation' ? current.message : undefined, options: current?.kind === 'confirmation' ? current.options : undefined, resolved: true, approved: event.approved }));
                break;
            case 'checkpoint.created':
                state.items = replaceItem(state.items, event.checkpointId, () => ({ id: event.checkpointId, kind: 'checkpoint', label: event.label, timestamp: event.timestamp, metrics: event.metrics }));
                break;
            case 'error':
                state.status = 'error';
                state.items = replaceItem(state.items, event.errorId, () => ({ id: event.errorId, kind: 'error', message: event.message }));
                break;
        }
        return state;
    }, { items: [], status: 'idle', source: 'demo', partTaskIds: {} });
}
function buildConversationRounds(timeline) {
    const groups = [];
    for (const item of timeline.items) {
        if (item.kind === 'message' && item.role === 'user') {
            groups.push({ id: item.id, user: item, items: [] });
            continue;
        }
        const current = groups.at(-1);
        if (current)
            current.items.push(item);
        else
            groups.push({ id: `round-${groups.length}`, items: [item] });
    }
    return groups.map((group, index) => {
        const isLast = index === groups.length - 1;
        const state = isLast && timeline.status === 'running' ? 'working' : 'worked';
        const checkpoint = [...group.items].reverse().find((item) => item.kind === 'checkpoint');
        const assistantMessages = group.items.filter((item) => item.kind === 'message' && item.role === 'assistant');
        const changes = group.items.filter((item) => item.kind === 'change');
        const ending = state === 'worked' ? assistantMessages.at(-1) : undefined;
        const endingChange = state === 'worked' && changes.length ? mergeRoundChanges(group.id, changes) : undefined;
        const nonMessageItems = group.items.filter((item) => (item !== checkpoint
            && item.kind !== 'change'
            && item.kind !== 'message'
            // task.updated can arrive before its first actual tool call. It is
            // bookkeeping, not a visible Working group by itself.
            && (item.kind !== 'task' || item.executions.length > 0)));
        const hasToolExecution = group.items.some((item) => item.kind === 'task' && item.executions.length > 0);
        // Working is a chronological stream, not a tool-only bucket.  An agent
        // often explains what it will inspect immediately before calling a tool;
        // retain that assistant part directly above its Task instead of moving all
        // prose below the collapsed Working group.
        const workingItems = hasToolExecution
            ? group.items.filter((item) => (item !== checkpoint
                && item.kind !== 'change'
                && item !== ending
                && (item.kind !== 'task' || item.executions.length > 0)))
            : [];
        const thinkingItems = hasToolExecution ? [] : groupTimelineErrors(nonMessageItems);
        const outputItems = hasToolExecution ? [] : assistantMessages.filter((item) => item !== ending);
        return { id: group.id, state, user: group.user, thinkingItems, workingItems: groupTimelineErrors(workingItems), outputItems, ending, endingChange, checkpoint };
    });
}
function groupTimelineErrors(items) {
    const groups = groupAgentErrorRecords(items.flatMap((item) => item.kind === 'error' ? [{ id: item.id, message: item.message }] : []));
    const byTitle = new Map(groups.map((group) => [group.title, group]));
    const emitted = new Set();
    const result = [];
    for (const item of items) {
        if (item.kind !== 'error') {
            result.push(item);
            continue;
        }
        const title = agentErrorTitle(item.message);
        if (emitted.has(title))
            continue;
        emitted.add(title);
        const group = byTitle.get(title);
        result.push(group ? { ...item, title: group.title, messages: group.messages } : item);
    }
    return result;
}
function mergeRoundChanges(roundId, entries) {
    // A Git snapshot represents the whole working tree at a precise point in
    // time. Do not sum snapshots from individual tool calls: doing so inflated
    // additions/deletions every time an agent made a second edit in one turn.
    const latestSnapshot = [...entries].reverse().find((entry) => entry.snapshot);
    if (latestSnapshot) {
        if (!latestSnapshot.files?.length)
            return undefined;
        return {
            ...latestSnapshot,
            id: `${roundId}:ending-changes`,
            changeCount: latestSnapshot.files.length,
        };
    }
    const hasAdditions = entries.some((change) => change.additions !== undefined);
    const hasDeletions = entries.some((change) => change.deletions !== undefined);
    const files = new Map();
    for (const change of entries) {
        for (const file of change.files ?? []) {
            const normalized = typeof file === 'string' ? { path: file } : file;
            const current = files.get(normalized.path);
            files.set(normalized.path, {
                path: normalized.path,
                additions: current?.additions === undefined && normalized.additions === undefined ? undefined : (current?.additions ?? 0) + (normalized.additions ?? 0),
                deletions: current?.deletions === undefined && normalized.deletions === undefined ? undefined : (current?.deletions ?? 0) + (normalized.deletions ?? 0),
            });
        }
    }
    return {
        id: `${roundId}:ending-changes`,
        kind: 'change',
        label: 'Applied changes',
        additions: hasAdditions ? entries.reduce((total, change) => total + (change.additions ?? 0), 0) : undefined,
        deletions: hasDeletions ? entries.reduce((total, change) => total + (change.deletions ?? 0), 0) : undefined,
        files: files.size ? [...files.values()] : undefined,
        changeCount: entries.length,
    };
}
function toolActionLabel(execution) {
    if (execution.kind === 'command')
        return 'Run';
    if (execution.kind === 'file') {
        if (execution.editState === 'editing' || execution.state === 'active')
            return '正在编辑';
        if (execution.editState === 'failed' || execution.state === 'failed')
            return '编辑失败';
        return 'Edited';
    }
    const name = execution.label.toLowerCase();
    if (/read|open/.test(name))
        return 'Read';
    if (/search|find|grep/.test(name))
        return 'Search';
    if (/edit|write|patch/.test(name))
        return 'Edit';
    if (/fetch|web|http|browser/.test(name))
        return 'Fetch';
    return humanizeToolName(execution.label);
}
function executionOrbState(execution) {
    const name = execution.label.toLowerCase();
    if (/read|open|search|find|grep/.test(name))
        return 'searching';
    if (/fetch|web|http|browser|connect/.test(name))
        return 'connecting';
    if (/edit|write|patch|file/.test(name))
        return 'shaping';
    if (/compose|generate/.test(name))
        return 'composing';
    return 'working';
}
function executionAction(execution) {
    if (execution.kind === 'command')
        return 'command';
    const name = execution.label.toLowerCase();
    if (/browser|playwright|navigate|screenshot/.test(name))
        return 'browser';
    if (/read|open/.test(name))
        return 'read';
    if (/search|find|grep/.test(name))
        return 'search';
    if (/edit|write|patch|file/.test(name))
        return 'edit';
    if (/fetch|web|http/.test(name))
        return 'fetch';
    return 'other';
}
function dynamicTaskLabel(executions, active) {
    if (!executions.length)
        return active ? 'Working' : 'Worked';
    const actions = new Map();
    for (const execution of executions) {
        const action = executionAction(execution);
        actions.set(action, (actions.get(action) ?? 0) + 1);
    }
    return [...actions].map(([action, count]) => {
        if (action === 'browser')
            return active ? 'Using the browser' : 'Used the browser';
        if (action === 'command')
            return active ? `Running ${count === 1 ? 'a command' : 'commands'}` : `Ran ${count === 1 ? 'a command' : 'commands'}`;
        if (action === 'edit')
            return active ? `正在编辑 ${count === 1 ? '文件' : `${count} 个文件`}` : `Edited ${count === 1 ? 'a file' : 'files'}`;
        if (action === 'read')
            return active ? `Reading ${count === 1 ? 'a file' : 'files'}` : `Read ${count === 1 ? 'a file' : 'files'}`;
        if (action === 'search')
            return active ? 'Searching the project' : 'Searched the project';
        if (action === 'fetch')
            return active ? `Fetching ${count === 1 ? 'a resource' : 'resources'}` : `Fetched ${count === 1 ? 'a resource' : 'resources'}`;
        return active ? `Using ${count === 1 ? 'a tool' : 'tools'}` : `Used ${count === 1 ? 'a tool' : 'tools'}`;
    }).join(', ');
}
function latestFlowForItems(items) {
    for (const item of [...items].reverse()) {
        if (item.kind === 'task' && item.executions.length) {
            const execution = item.executions.findLast((candidate) => candidate.state === 'active') ?? item.executions.at(-1);
            return { label: dynamicTaskLabel(item.executions, item.state === 'active'), state: executionOrbState(execution) };
        }
    }
    for (const item of [...items].reverse()) {
        if (item.kind === 'message')
            return { label: item.streaming ? '正在生成回复' : '生成回复', state: 'composing' };
        if (item.kind === 'reasoning')
            return { label: item.streaming ? '正在思考' : '完成思考', state: 'solving' };
        if (item.kind === 'status')
            return { label: item.label, state: 'working' };
        if (item.kind === 'change')
            return { label: item.label, state: 'shaping' };
    }
    return IDLE_FLOW_STATUS;
}
const IDLE_FLOW_STATUS = { label: 'Solving', state: 'solving' };
const CAPSULE_ORB_SIZE = 30;
const TASK_POSITION_TOLERANCE = 8;
function getActiveFlowStatus(timeline) {
    if (timeline.status !== 'running')
        return null;
    for (const item of [...timeline.items].reverse()) {
        if (item.kind === 'confirmation' && !item.resolved)
            return { label: '等待你的回答', state: 'working' };
        if (item.kind === 'message' && item.streaming)
            return { label: '正在生成回复', state: 'composing' };
        if (item.kind === 'reasoning' && item.streaming)
            return { label: '正在思考', state: 'solving' };
        if (item.kind === 'status' && item.state === 'active')
            return { label: item.label, state: 'working' };
        if (item.kind === 'task' && item.state === 'active') {
            const execution = [...item.executions].reverse().find((candidate) => candidate.state === 'active');
            return {
                label: execution ? `${toolActionLabel(execution)} · ${item.label}` : item.label,
                state: execution ? executionOrbState(execution) : 'working',
            };
        }
    }
    const latest = latestFlowForItems(timeline.items);
    return latest === IDLE_FLOW_STATUS ? { label: '正在思考', state: 'solving' } : latest;
}
function TaskPositionCapsule({ activeFlow }) {
    const { contentRef, escapedFromLock, scrollRef, scrollToBottom } = useStickToBottomContext();
    const capsuleFlow = activeFlow ?? IDLE_FLOW_STATUS;
    const [awayFromTaskPosition, setAwayFromTaskPosition] = useState(false);
    useEffect(() => {
        const scrollElement = scrollRef.current;
        const contentElement = contentRef.current;
        if (!scrollElement || !contentElement)
            return;
        const updatePosition = () => {
            const distanceFromTask = scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop;
            setAwayFromTaskPosition(distanceFromTask > TASK_POSITION_TOLERANCE);
        };
        updatePosition();
        scrollElement.addEventListener('scroll', updatePosition, { passive: true });
        const resizeObserver = new ResizeObserver(updatePosition);
        resizeObserver.observe(contentElement);
        return () => {
            scrollElement.removeEventListener('scroll', updatePosition);
            resizeObserver.disconnect();
        };
    }, [contentRef, scrollRef]);
    if (!awayFromTaskPosition || !escapedFromLock)
        return null;
    return (_jsxs("button", { "aria-label": activeFlow ? '返回正在工作的位置' : '返回任务位置', className: "absolute bottom-3 left-1/2 z-30 flex h-10 max-w-[calc(100%_-_24px)] -translate-x-1/2 items-center gap-1.5 overflow-hidden rounded-full border border-[var(--app-status-glass-border)] bg-[var(--app-status-glass)] py-1 pl-1.5 pr-3 text-left text-[var(--app-status-glass-foreground)] shadow-[inset_0_0_50px_rgb(255_255_255_/_1%),0_16px_48px_var(--app-shadow)] backdrop-blur-xl transition-transform active:scale-[0.98]", onClick: () => scrollToBottom(), type: "button", children: [_jsx(ThinkingOrb, { "aria-label": capsuleFlow.label, className: "shrink-0", size: CAPSULE_ORB_SIZE, speed: activeFlow ? 1 : 0.5, state: capsuleFlow.state }), _jsx("span", { className: "min-w-0 max-w-[160px] truncate text-[12px] font-normal leading-[14px]", children: activeFlow?.label ?? '空闲中' })] }));
}
function executionInput(execution) {
    const input = execution.input && typeof execution.input === 'object'
        ? execution.input
        : {};
    const toolName = execution.label.toLowerCase();
    const primaryKeys = execution.kind === 'file' && execution.path
        ? []
        : execution.kind === 'command'
            ? ['command']
            : /search|find|grep/.test(toolName)
                ? ['query', 'path', 'target']
                : /fetch|web|http|browser/.test(toolName)
                    ? ['url', 'query', 'target']
                    : ['path', 'filePath', 'file_path', 'target', 'query', 'url', 'command'];
    const primaryEntry = primaryKeys
        .map((key) => [key, input[key]])
        .find((entry) => typeof entry[1] === 'string');
    const primary = execution.path ?? primaryEntry?.[1] ?? (typeof execution.input === 'string' ? execution.input : execution.label);
    const displayValue = primaryEntry && /^(path|filePath|file_path|target)$/.test(primaryEntry[0]) && /[\\/]/.test(primary)
        ? primary.split(/[\\/]/).at(-1) ?? primary
        : primary;
    const start = input.line_start ?? input.lineStart ?? input.startLine;
    const end = input.line_end ?? input.lineEnd ?? input.endLine;
    const range = typeof start === 'number'
        ? `Lines ${start}${typeof end === 'number' ? `-${end}` : ''}`
        : undefined;
    return { displayValue, primary, range, title: [primary, range, execution.error ?? execution.output].filter(Boolean).join(' · ') };
}
function StatusGlyph({ running, label, doneIcon, orbState = 'working' }) {
    // Running tasks keep the animated orb; settled tasks switch to a static
    // HugeIcon SVG that corresponds to the task type. Both states share one
    // fixed 20px footprint (orb is 20px, icon 16px centered inside it) so the
    // icon column — and the title's first letter after it — never shifts
    // vertically or horizontally when a task settles.
    return (_jsx("span", { "aria-label": label, className: "flex size-5 shrink-0 items-center justify-center", children: running
            ? _jsx(ThinkingOrb, { className: "shrink-0", size: 20, state: orbState })
            : _jsx(HugeiconsIcon, { className: "size-4 shrink-0 text-[var(--app-subtle-foreground)]", icon: doneIcon ?? BadgeCheckIcon }) }));
}
function executionDoneIcon(execution) {
    if (execution.kind === 'command')
        return SquareTerminalIcon;
    if (execution.kind === 'file')
        return Edit01Icon;
    const name = execution.label.toLowerCase();
    if (/read|open|search|find|grep/.test(name))
        return BookOpen01Icon;
    return BadgeCheckIcon;
}
function ExecutionIcon({ execution }) {
    const action = toolActionLabel(execution);
    const stateLabel = execution.state === 'active'
        ? `${action} 中`
        : execution.state === 'failed'
            ? `${action} 失败`
            : execution.state === 'completed'
                ? `${action} 已完成`
                : `${action} 等待中`;
    return (_jsx(StatusGlyph, { doneIcon: executionDoneIcon(execution), label: stateLabel, orbState: executionOrbState(execution), running: execution.state === 'active' }));
}
function TaskExecutionRow({ execution }) {
    const [open, setOpen] = useState(false);
    const detailsId = useId();
    const input = executionInput(execution);
    const expandable = execution.kind === 'command' || execution.kind === 'file';
    const command = execution.kind === 'command' ? input.primary : undefined;
    const output = execution.error ?? execution.output;
    return (_jsxs("div", { className: "min-w-0 text-[13px] leading-4 tracking-[-0.0762px] text-[var(--app-muted)]", children: [_jsxs("div", { className: "flex h-6 min-w-0 items-center gap-2", children: [_jsx("span", { className: execution.state === 'failed' ? 'w-14 shrink-0 truncate text-[var(--destructive)]' : 'w-14 shrink-0 truncate', children: toolActionLabel(execution) }), _jsxs("button", { "aria-controls": expandable ? detailsId : undefined, "aria-expanded": expandable ? open : undefined, className: `flex h-6 min-w-0 max-w-[200px] items-center gap-1.5 overflow-hidden rounded-md border pl-1 pr-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--app-muted)] ${expandable ? 'cursor-pointer hover:border-[var(--app-muted)]' : 'cursor-default'} ${execution.state === 'failed' ? 'border-[color-mix(in_oklab,var(--destructive)_35%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)]' : 'border-[var(--app-control-border)] bg-[var(--app-active)]'}`, disabled: !expandable, onClick: () => expandable && setOpen((value) => !value), title: input.title, type: "button", children: [_jsx("span", { className: `flex shrink-0 items-center justify-center ${execution.state === 'active' ? 'size-5' : 'size-4'}`, children: _jsx(ExecutionIcon, { execution: execution }) }), _jsx("span", { className: "min-w-0 truncate", children: input.displayValue }), input.range && _jsx("span", { className: "shrink-0 text-[var(--app-subtle-foreground)]", children: input.range })] })] }), expandable && open ? (_jsx("div", { className: "mt-2 max-h-[240px] w-full max-w-[350px] space-y-2 overflow-y-auto font-mono text-[13px] leading-5 text-[var(--app-muted)]", id: detailsId, children: execution.kind === 'file' ? (execution.content !== undefined ? _jsx(ChatCodePreview, { className: "max-w-none", content: execution.content, language: execution.language, path: execution.path ?? input.primary, streaming: execution.editState === 'editing' }) : _jsx("p", { className: "rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-[12px] text-[var(--app-muted)]", children: "\u7B49\u5F85\u4EE3\u7801\u5185\u5BB9\u2026" })) : (_jsxs(_Fragment, { children: [_jsx("pre", { className: "overflow-x-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-[var(--app-foreground)]", children: _jsxs("code", { className: "whitespace-pre", children: ["$ ", command] }) }), output ? _jsx("pre", { className: "overflow-x-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-[var(--app-foreground)]", children: _jsx("code", { className: "whitespace-pre-wrap break-words", children: output }) }) : null] })) })) : null] }));
}
function TaskGroupItem({ item }) {
    const [open, setOpen] = useState(false);
    const latestExecution = item.executions.findLast((execution) => execution.state === 'active') ?? item.executions.at(-1);
    const title = item.executions.length ? dynamicTaskLabel(item.executions, item.state === 'active') : item.label;
    const orbState = latestExecution ? executionOrbState(latestExecution) : 'working';
    return (_jsxs(Task, { className: "w-full", onOpenChange: setOpen, open: open, children: [_jsx(TaskTrigger, { className: "w-full", title: title, children: _jsxs("div", { className: "flex h-7 w-full items-center gap-2 overflow-hidden rounded-md text-left text-[13px] leading-[21.125px] tracking-[-0.0762px] text-[var(--app-muted)] transition-colors hover:text-[var(--app-foreground)]", children: [_jsx(StatusGlyph, { doneIcon: BadgeCheckIcon, label: title, orbState: orbState, running: item.state === 'active' }), _jsx("span", { className: "min-w-0 flex-1 truncate", children: title }), _jsx(ChevronDown, { className: `size-[13px] shrink-0 transition-transform ${open ? '' : '-rotate-90'}` })] }) }), _jsxs(TaskContent, { className: "[&>div]:mt-0 [&>div]:grid [&>div]:max-h-[240px] [&>div]:grid-cols-[28px_minmax(0,1fr)] [&>div]:space-y-0 [&>div]:overflow-x-hidden [&>div]:overflow-y-auto [&>div]:overscroll-contain [&>div]:border-0 [&>div]:pl-0", children: [_jsx("div", { className: "relative h-full", children: _jsx("span", { className: "absolute left-[9.5px] top-0 h-full w-px bg-gradient-to-b from-[var(--app-border)] to-transparent" }) }), _jsxs("div", { className: "flex min-w-0 flex-col gap-2 pt-2", children: [item.executions.map((execution) => _jsx(TaskExecutionRow, { execution: execution }, execution.id)), item.executions.length === 0 && item.detail ? _jsx("p", { className: "text-[12px] leading-5 text-[var(--app-muted)]", children: item.detail }) : null] })] })] }));
}
function StatusItem({ item }) {
    return (_jsxs("div", { className: "flex h-7 items-center gap-2 text-[13px] leading-[21px] tracking-[-0.0762px] text-[var(--app-muted)]", children: [_jsx(StatusGlyph, { doneIcon: BadgeCheckIcon, label: `${item.label}${item.state === 'active' ? '中' : item.state === 'failed' ? '失败' : '已完成'}`, running: item.state === 'active' }), _jsxs("div", { className: "min-w-0 leading-[21px]", children: [_jsx("p", { children: item.label }), item.detail ? _jsx("p", { className: "text-[12px] text-[var(--app-subtle-foreground)]", children: item.detail }) : null] })] }));
}
function isLegacyRuntimeSnapshotPath(input) {
    const segments = input.replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(Boolean);
    if (segments.some((segment) => ['.agents', '.cache', '.codex', '.local', '.openlink', '.supabase'].includes(segment)))
        return true;
    const basename = segments.at(-1) ?? '';
    return /\.log(?:\.[^/]*)?$/i.test(basename) || /^(?:stderr|stdout)(?:[-_.].*)?\.(?:log|txt)$/i.test(basename);
}
function ChangeItem({ item }) {
    const [open, setOpen] = useState(false);
    const [selectedPath, setSelectedPath] = useState();
    // Old persisted snapshots may predate the Worker-level exclusion policy.
    // Filter them at render time as a migration guard; all new snapshots are
    // already clean at collection time.
    const files = (item.files ?? []).map((file) => typeof file === 'string' ? { path: file } : file).filter((file) => !isLegacyRuntimeSnapshotPath(file.path));
    const selected = files.find((file) => file.path === selectedPath) ?? files[0];
    const additions = item.snapshot ? files.reduce((total, file) => total + (file.additions ?? 0), 0) : item.additions;
    const deletions = item.snapshot ? files.reduce((total, file) => total + (file.deletions ?? 0), 0) : item.deletions;
    if (item.snapshot && files.length === 0)
        return null;
    return (_jsxs("div", { className: `overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--app-foreground)_16%,var(--app-border))] bg-[var(--app-elevated)] p-2 shadow-[0_6px_20px_var(--app-shadow)] transition-[max-height,border-color] duration-200 ease-out ${open ? 'max-h-[540px] border-[color-mix(in_oklab,var(--app-foreground)_24%,var(--app-border))]' : 'max-h-[46px]'}`, "data-slot": "git-snapshot", children: [_jsxs("div", { className: "flex h-7 items-center gap-1", children: [_jsxs("button", { "aria-expanded": open, className: "flex h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md text-left outline-none hover:text-[var(--app-foreground)] focus:outline-none focus-visible:outline-none", onClick: () => setOpen((value) => !value), type: "button", children: [open ? _jsx(ChevronDown, { className: "size-[13px] shrink-0 text-[var(--app-muted)]" }) : _jsx(ChevronRight, { className: "size-[13px] shrink-0 text-[var(--app-muted)]" }), _jsx("span", { className: "min-w-0 truncate text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-foreground)]", children: item.label }), item.baseCommit ? _jsxs("span", { className: "shrink-0 font-mono text-[11px] text-[var(--app-muted)]", children: ["@", item.baseCommit] }) : item.changeCount && item.changeCount > 1 ? _jsxs("span", { className: "shrink-0 text-[12px] text-[var(--app-muted)]", children: ["v", item.changeCount] }) : null] }), (additions !== undefined || deletions !== undefined) && (_jsxs("button", { "aria-label": "\u67E5\u770B\u5DEE\u5F02", className: "flex h-6 shrink-0 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-active)] px-2 text-xs font-semibold hover:bg-[var(--app-hover)]", type: "button", children: [_jsxs("span", { className: "text-[var(--app-success)]", children: ["+", additions ?? 0] }), _jsx("span", { className: "px-0.5 text-[var(--app-muted)]", children: "/" }), _jsxs("span", { className: "text-[var(--app-danger)]", children: ["-", deletions ?? 0] })] })), _jsx("button", { "aria-label": open ? '收起 Git 变更' : '展开 Git 变更', className: "flex size-6 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]", onClick: () => setOpen((value) => !value), type: "button", children: _jsx(RotateCcw, { className: "size-3.5" }) })] }), open && files.length ? (_jsxs("div", { className: "max-h-[480px] overflow-y-auto pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", children: [_jsx("div", { className: "space-y-0.5", children: files.map((change) => {
                            const segments = change.path.split('/');
                            const name = segments.at(-1) ?? change.path;
                            const directory = segments.slice(0, -1).join('/');
                            return (_jsxs("button", { "aria-pressed": selected?.path === change.path, className: `flex h-7 w-full min-w-0 items-center gap-2 rounded px-0.5 text-left transition-colors hover:bg-[var(--app-hover)] ${selected?.path === change.path ? 'bg-[var(--app-active)]' : ''}`, onClick: () => setSelectedPath(change.path), type: "button", children: [_jsx(Atom, { className: "size-4 shrink-0 text-[var(--app-info)]" }), _jsx("span", { className: "shrink-0 text-[13px] text-[var(--app-foreground)]", children: name }), _jsx("span", { className: "min-w-0 flex-1 truncate text-[12px] text-[var(--app-subtle-foreground)]", children: directory }), (change.additions !== undefined || change.deletions !== undefined) && (_jsxs("span", { className: "flex shrink-0 items-center gap-0.5 text-[12px]", children: [_jsxs("span", { className: "text-[var(--app-success)]", children: ["+", change.additions ?? 0] }), change.deletions ? _jsxs("span", { className: "text-[var(--app-danger)]", children: ["/-", change.deletions] }) : null] }))] }, change.path));
                        }) }), selected?.patch ? (_jsx("pre", { className: "mt-2 max-h-[248px] overflow-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-2 font-mono text-[11px] leading-4 text-[var(--app-foreground)]", children: _jsx("code", { className: "whitespace-pre-wrap break-words", children: selected.patch }) })) : item.snapshot ? _jsx("p", { className: "mt-2 text-[12px] text-[var(--app-muted)]", children: "Git detected this file, but it has no text diff to preview." }) : null] })) : null] }));
}
function ConfirmationResultItem({ item }) {
    const approved = item.approved ?? false;
    return (_jsxs("div", { "aria-label": `${item.title}，${approved ? '已批准执行' : '已拒绝执行'}`, className: "flex h-6 min-w-0 items-center gap-2 text-[13px] leading-4 tracking-[-0.0762px] text-[var(--app-muted)]", role: "status", children: [_jsx("span", { className: "w-14 shrink-0 truncate", children: approved ? '批准' : '跳过' }), _jsxs("div", { className: "flex h-6 min-w-0 max-w-[200px] items-center gap-1.5 overflow-hidden rounded-md border border-[var(--app-control-border)] bg-[var(--app-active)] pl-1 pr-1.5", children: [_jsx("span", { className: "flex size-4 shrink-0 items-center justify-center", children: approved
                            ? _jsx(CircleCheck, { className: "size-[14px] text-[var(--app-success)]" })
                            : _jsx(CircleAlert, { className: "size-[14px] text-[var(--destructive)]" }) }), _jsx("span", { className: "min-w-0 truncate text-[var(--app-foreground)]", children: item.title })] })] }));
}
function formatRelativeTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime());
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1)
        return 'now';
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
function formatClockTime(timestamp) {
    return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
    }).format(new Date(timestamp));
}
function UserPromptAttachments({ attachments }) {
    if (!attachments.length)
        return null;
    return _jsx("div", { className: "mb-1.5 flex flex-wrap gap-2", children: attachments.map((attachment, index) => attachment.type === 'image'
            ? _jsx("img", { alt: attachment.filename ?? `图片 ${index + 1}`, className: "max-h-64 max-w-full rounded-lg object-contain", src: attachment.url }, `${attachment.url.slice(0, 48)}:${index}`)
            : attachment.type === 'reference'
                ? _jsxs("div", { className: "flex max-w-full items-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 py-1.5 text-left", children: [attachment.referenceType === 'thread' ? _jsx(MessageCircle, { "aria-hidden": true, className: "size-4 shrink-0 text-[var(--app-muted)]" }) : _jsx(FileText, { "aria-hidden": true, className: "size-4 shrink-0 text-[var(--app-muted)]" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block truncate text-xs font-medium", children: attachment.name }), _jsx("span", { className: "block truncate text-[10px] text-[var(--app-muted)]", children: attachment.referenceType === 'thread' ? '任务引用' : attachment.path })] })] }, `reference:${attachment.path}`)
                : _jsxs("div", { className: "flex max-w-full items-center gap-2 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-surface)] px-2 py-1.5 text-left", children: [_jsx(FileText, { "aria-hidden": true, className: "size-4 shrink-0 text-[var(--app-muted)]" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block truncate text-xs font-medium", children: attachment.filename ?? '已粘贴的文本.txt' }), _jsxs("span", { className: "block text-[10px] text-[var(--app-muted)]", children: [attachment.text.length.toLocaleString(), " \u4E2A\u5B57\u7B26"] })] })] }, `text:${index}:${attachment.text.length}`)) });
}
function TimelineMessageItem({ item }) {
    return (_jsx(Message, { className: item.role === 'user' ? 'mb-4 max-w-[95%]' : 'max-w-full', from: item.role, children: _jsxs(MessageContent, { className: item.role === 'user'
                ? 'relative isolate min-h-[34px] overflow-hidden rounded-xl! border border-[var(--app-control-border)] bg-[var(--app-active)]! px-3! py-1.5! text-[13px] leading-[21.125px] text-[var(--app-foreground)]! before:hidden after:hidden'
                : 'w-full gap-0 overflow-visible text-[13px] leading-[21.125px]', children: [item.role === 'assistant'
                    ? _jsx(MessageResponse, { className: "chat-message-markdown text-[13px] leading-[21.125px] [&_li]:my-1 [&_p]:my-0 [&_ul]:list-outside [&_ul]:pl-[1.5em] [&_ul]:my-1 [&_ol]:list-outside [&_ol]:pl-[1.5em] [&_ol]:my-1 [&_li>p]:inline", children: item.text })
                    : _jsxs(_Fragment, { children: [item.attachments?.length ? _jsx(UserPromptAttachments, { attachments: item.attachments }) : null, item.text ? _jsx("p", { className: "whitespace-pre-wrap break-words", children: item.text }) : null] }), item.streaming && _jsx("span", { className: "inline-block h-3 w-1 animate-pulse bg-[var(--app-foreground)]" })] }) }));
}
function EditableUserMessage({ item, disabled, onEditMessage }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(item.text);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(null);
    const trigger = useRef(null);
    const cancel = () => { setEditing(false); setError(null); requestAnimationFrame(() => trigger.current?.focus()); };
    const submit = async () => {
        if (pending || disabled || !draft.trim() || !onEditMessage)
            return;
        setPending(true);
        setError(null);
        try {
            await onEditMessage(item.id, draft.trim());
            setEditing(false);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : '重发失败，修改内容已保留');
        }
        finally {
            setPending(false);
        }
    };
    return _jsxs("div", { className: "relative flex w-full justify-end", "data-message-id": item.id, children: [editing && _jsx("div", { "aria-hidden": "true", className: "invisible mb-4 max-w-[95%] whitespace-pre-wrap break-words rounded-xl border px-3 py-1.5 text-[13px] leading-[21.125px]", children: item.text }), editing ? _jsxs("form", { "aria-label": "\u7F16\u8F91\u539F\u6D88\u606F", className: "absolute left-1/2 top-0 z-20 mx-auto flex w-[95%] min-w-0 -translate-x-1/2 flex-col gap-3 rounded-xl border border-dashed border-[var(--app-muted)] bg-[var(--app-elevated)] p-3 shadow-[0_12px_36px_var(--app-shadow)]", onSubmit: (event) => { event.preventDefault(); void submit(); }, onKeyDown: (event) => {
                    if (event.nativeEvent.isComposing)
                        return;
                    if (event.key === 'Escape' && !pending) {
                        event.preventDefault();
                        cancel();
                    }
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submit();
                    }
                }, children: [_jsx("textarea", { autoFocus: true, "aria-label": "\u6D88\u606F\u5185\u5BB9", className: "min-h-20 max-h-64 w-full resize-y bg-transparent text-[13px] leading-[21px] text-[var(--app-foreground)] outline-none", value: draft, maxLength: 10000, disabled: pending, onChange: (event) => setDraft(event.target.value) }), _jsx("p", { className: "text-[11px] leading-4 text-[var(--app-muted)]", children: "\u4ECE\u6B64\u5904\u91CD\u65B0\u751F\u6210\u540E\u7EED\u5BF9\u8BDD\uFF0C\u4E0D\u56DE\u6EDA\u6587\u4EF6\u4FEE\u6539\u3002" }), error && _jsx("p", { role: "alert", className: "text-xs text-red-500", children: error }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { type: "button", className: "rounded-md px-3 py-1.5 text-xs hover:bg-[var(--app-hover)] focus-visible:outline", disabled: pending, onClick: cancel, children: "\u53D6\u6D88" }), _jsx("button", { type: "submit", className: "rounded-md bg-[var(--app-submit-background)] px-3 py-1.5 text-xs text-[var(--app-submit-foreground)] disabled:opacity-40 focus-visible:outline", disabled: pending || disabled || !draft.trim(), children: pending ? '正在重发…' : '重发' })] })] }) : _jsx("button", { ref: trigger, type: "button", "aria-label": `编辑消息：${item.text}`, disabled: disabled || !onEditMessage, className: "mb-4 max-w-[95%] whitespace-pre-wrap break-words rounded-xl border border-[var(--app-control-border)] bg-[var(--app-active)] px-3 py-1.5 text-left text-[13px] leading-[21.125px] text-[var(--app-foreground)] outline-none hover:border-[var(--app-muted)] focus-visible:ring-1 focus-visible:ring-[var(--app-muted)]", onClick: () => { setDraft(item.text); setError(null); setEditing(true); }, children: item.text })] });
}
function ErrorItem({ item }) {
    const [open, setOpen] = useState(false);
    const detailsId = useId();
    const messages = item.messages ?? [item.message];
    const title = item.title ?? agentErrorTitle(item.message);
    return (_jsxs("div", { className: "py-0.5", "data-slot": "timeline-error", children: [_jsxs("button", { "aria-controls": detailsId, "aria-expanded": open, className: "group flex min-h-6 w-full items-center gap-2 text-left text-[12px] leading-5 text-[color-mix(in_oklab,var(--app-danger)_62%,var(--app-muted))] outline-none transition-colors hover:text-[var(--app-danger)] focus-visible:text-[var(--app-danger)]", onClick: () => setOpen((value) => !value), type: "button", children: [_jsx(CircleAlert, { className: "size-3.5 shrink-0" }), _jsx("span", { className: "min-w-0 flex-1 truncate font-medium", children: title }), messages.length > 1 ? _jsx("span", { "aria-label": `${messages.length} 次`, className: "shrink-0 tabular-nums text-[var(--app-subtle-foreground)]", children: messages.length }) : null, _jsx(ChevronRight, { className: `size-3 shrink-0 text-[var(--app-subtle-foreground)] transition-transform ${open ? 'rotate-90' : ''}` })] }), open ? _jsx("div", { className: "ml-[6px] mt-1 max-h-44 space-y-2 overflow-y-auto border-l border-[var(--app-border)] py-1 pl-[18px] pr-1 text-[11px] leading-[18px] text-[var(--app-muted)] [scrollbar-width:thin]", id: detailsId, children: messages.map((message, index) => _jsxs("div", { className: "whitespace-pre-wrap break-words", children: [_jsxs("span", { className: "mr-2 font-mono text-[10px] text-[var(--app-subtle-foreground)]", children: ["#", index + 1] }), message] }, `${index}:${message}`)) }) : null] }));
}
function TimelineItemView({ item }) {
    if (item.kind === 'message')
        return _jsx(TimelineMessageItem, { item: item });
    if (item.kind === 'reasoning') {
        return (_jsxs(Reasoning, { className: "mb-0!", defaultOpen: false, duration: item.durationMs ? Math.max(1, Math.round(item.durationMs / 1000)) : undefined, isStreaming: item.streaming, children: [_jsxs(ReasoningTrigger, { className: "h-7 gap-2 text-[13px] leading-[21px] tracking-[-0.0762px]", getThinkingMessage: (streaming) => streaming ? _jsx("span", { children: "Thinking\u2026" }) : _jsx("span", { children: "Thought for a moment" }), children: [_jsx(StatusGlyph, { doneIcon: AiBrain02Icon, label: item.streaming ? '正在思考' : '思考已完成', orbState: "solving", running: item.streaming }), _jsx("span", { children: item.streaming ? 'Thinking…' : 'Thought for a moment' })] }), item.text && _jsx(ReasoningContent, { className: "relative mt-2 pl-7 text-[12px] leading-5 before:absolute before:inset-y-0 before:left-[9.5px] before:w-px before:bg-gradient-to-b before:from-[var(--app-border)] before:to-transparent", children: item.text })] }));
    }
    if (item.kind === 'task')
        return _jsx(TaskGroupItem, { item: item });
    if (item.kind === 'status')
        return _jsx(StatusItem, { item: item });
    if (item.kind === 'change')
        return _jsx(ChangeItem, { item: item });
    if (item.kind === 'confirmation')
        return item.resolved ? _jsx(ConfirmationResultItem, { item: item }) : null;
    if (item.kind === 'checkpoint')
        return null;
    return _jsx(ErrorItem, { item: item });
}
function StreamingThinkingItem() {
    return (_jsxs("div", { className: "flex h-7 items-center gap-2 text-[13px] leading-[21px] text-[var(--app-muted)]", "data-streaming-thinking": true, children: [_jsx("span", { className: "flex size-5 shrink-0 items-center justify-center", children: _jsx(ThinkingOrb, { "aria-label": "\u6B63\u5728\u601D\u8003", className: "shrink-0", size: 20, state: "solving" }) }), _jsx("span", { children: "Thinking\u2026" })] }));
}
function WorkFlowGroup({ activeFlow, children, round, }) {
    const [open, setOpen] = useState(round.state === 'working');
    const checkpoint = round.checkpoint;
    const flow = round.state === 'working' && activeFlow ? activeFlow : latestFlowForItems(round.workingItems);
    const label = round.state === 'working' ? 'Working' : checkpoint?.label ?? 'Worked';
    const checkpointText = checkpoint ? [
        checkpoint.label,
        `${checkpoint.metrics?.actions ?? 0} actions`,
        `${checkpoint.metrics?.credits?.toFixed(3) ?? '0.000'} credits`,
        checkpoint.metrics?.model ?? 'Fable 5',
    ].join('\n') : '';
    useEffect(() => {
        if (round.state === 'worked')
            setOpen(false);
    }, [round.state]);
    const copyCheckpointLink = () => {
        if (!checkpoint)
            return;
        const url = new URL(window.location.href);
        url.hash = `checkpoint-${checkpoint.id}`;
        void navigator.clipboard.writeText(url.toString());
    };
    const requestRetry = (mode) => {
        if (!checkpoint)
            return;
        window.dispatchEvent(new CustomEvent('openlink:retry-checkpoint', {
            detail: { checkpointId: checkpoint.id, mode },
        }));
    };
    return (_jsxs("section", { className: `flex w-full flex-col text-[13px] tracking-[-0.0762px] text-[var(--app-subtle-foreground)] ${round.state === 'worked' ? 'border-b border-[var(--app-border)]' : ''}`, id: checkpoint ? `checkpoint-${checkpoint.id}` : undefined, children: [_jsxs("div", { className: `flex min-h-9 w-full items-center gap-2 border-[var(--app-border)] ${round.state === 'working' && open ? 'border-b' : ''}`, children: [_jsxs("button", { "aria-expanded": open, className: "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:text-[var(--app-foreground)] focus-visible:ring-0", onClick: () => setOpen((value) => !value), type: "button", children: [_jsx(StatusGlyph, { doneIcon: BadgeCheckIcon, label: flow.label, orbState: flow.state, running: round.state === 'working' }), _jsx("span", { className: "truncate text-[14px] font-medium", children: label }), _jsx(ChevronDown, { className: `size-[13px] shrink-0 transition-transform ${open ? '' : '-rotate-90'}` })] }), checkpoint ? _jsxs("span", { className: "hidden shrink-0 items-center gap-1 sm:flex", children: [_jsx(Clock3, { className: "size-[13px]" }), open ? formatClockTime(checkpoint.timestamp) : formatRelativeTime(checkpoint.timestamp)] }) : null, checkpoint ? _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { render: _jsx("button", { "aria-label": "\u66F4\u591A\u8FD0\u884C\u64CD\u4F5C", className: "flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] data-popup-open:bg-[var(--app-active)] data-popup-open:text-[var(--app-foreground)]", type: "button" }), children: _jsx(MoreHorizontal, { className: "size-4" }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-[164px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0", side: "top", sideOffset: 8, children: [_jsxs(DropdownMenuSub, { children: [_jsxs(DropdownMenuSubTrigger, { className: "h-8 cursor-pointer gap-2.5 rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)] data-popup-open:bg-[var(--app-hover)]", children: [_jsx(RefreshCw, { className: "size-4 text-[var(--app-muted)]" }), _jsx("span", { children: "\u91CD\u8BD5" })] }), _jsxs(DropdownMenuSubContent, { className: "w-[144px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 shadow-[0_12px_36px_var(--app-shadow)] ring-0", children: [_jsx(DropdownMenuItem, { className: "h-8 cursor-pointer rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]", onClick: () => requestRetry('from-checkpoint'), children: "\u4ECE\u6B64\u5904\u91CD\u8BD5" }), _jsx(DropdownMenuItem, { className: "h-8 cursor-pointer rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]", onClick: () => requestRetry('same-model'), children: "\u4F7F\u7528\u76F8\u540C\u6A21\u578B" })] })] }), _jsxs(DropdownMenuItem, { className: "h-8 cursor-pointer gap-2.5 rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]", onClick: () => { void navigator.clipboard.writeText(checkpointText); }, children: [_jsx(Copy, { className: "size-4 text-[var(--app-muted)]" }), _jsx("span", { children: "\u590D\u5236" })] }), _jsxs(DropdownMenuItem, { className: "h-8 cursor-pointer gap-2.5 rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]", onClick: copyCheckpointLink, children: [_jsx(Link2, { className: "size-4 text-[var(--app-muted)]" }), _jsx("span", { children: "Copy Link" })] })] })] }) : null] }), _jsx("div", { className: `grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`, children: _jsx("div", { className: "flex min-h-0 flex-col gap-2 overflow-hidden pb-2 pt-2", children: children }) })] }));
}
function EndingSection({ round }) {
    if (round.state !== 'worked' || (!round.ending && !round.endingChange))
        return null;
    const hasWorkingGroup = round.workingItems.length > 0;
    return (_jsxs("div", { className: `flex flex-col gap-3 ${hasWorkingGroup ? '-mt-1' : ''}`, "data-message-phase": "ending", children: [round.ending ? _jsx("div", { "data-ending-item": "summary", children: _jsx(TimelineMessageItem, { item: round.ending }) }) : null, round.endingChange ? _jsx("div", { "data-ending-item": "applied-changes", children: _jsx(ChangeItem, { item: round.endingChange }) }) : null] }));
}
export function ChatTimeline({ events, isStreaming = false, onFlowStatusChange, onEditMessage, }) {
    const timeline = useMemo(() => buildTimeline(projectMessageRevisions(events)), [events]);
    const rounds = useMemo(() => buildConversationRounds(timeline), [timeline]);
    const activeFlow = useMemo(() => getActiveFlowStatus(timeline) ?? (isStreaming ? { label: '正在思考', state: 'solving' } : null), [isStreaming, timeline]);
    useEffect(() => {
        onFlowStatusChange?.(activeFlow);
    }, [activeFlow, onFlowStatusChange]);
    return (_jsxs(Conversation, { className: "min-h-0 flex-1", children: [_jsxs(ConversationContent, { className: "min-h-full gap-5 px-3 pb-6 pt-20 text-[13px] leading-[21.125px] tracking-[-0.0762px]", children: [rounds.map((round) => (_jsxs("section", { className: "flex w-full flex-col gap-3", "data-round-state": round.state, children: [round.user ? _jsx(EditableUserMessage, { item: round.user, disabled: isStreaming, onEditMessage: onEditMessage }) : null, round.thinkingItems.map((item) => _jsx(TimelineItemView, { item: item }, item.id)), isStreaming && round === rounds.at(-1) && !round.thinkingItems.length && !round.workingItems.length && !round.outputItems.length && !round.ending ? _jsx(StreamingThinkingItem, {}) : null, round.workingItems.length || round.checkpoint ? (_jsx(WorkFlowGroup, { activeFlow: round.state === 'working' ? activeFlow : null, round: round, children: round.workingItems.map((item) => _jsx(TimelineItemView, { item: item }, item.id)) })) : null, round.outputItems.map((item) => _jsx(TimelineMessageItem, { item: item }, item.id)), _jsx(EndingSection, { round: round })] }, round.id))), _jsx("div", { className: "h-px w-full", "data-task-position": "current" })] }), _jsx(TaskPositionCapsule, { activeFlow: activeFlow })] }));
}
