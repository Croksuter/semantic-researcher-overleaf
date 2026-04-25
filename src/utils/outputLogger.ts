import * as vscode from 'vscode';
import { ELEGANT_NAME } from '../consts';

let outputChannel: vscode.OutputChannel | undefined;
type LogLevel = 'info'|'warn'|'error';

const levelAliases: Record<LogLevel, string> = {
    info: 'I',
    warn: 'W',
    error: 'E',
};

const scopeAliases = new Map<string, string>([
    ['http', 'http'],
    ['socket', 'sock'],
    ['server-change', 'srv'],
    ['local-change', 'local'],
    ['local-replica', 'replica'],
    ['vfs', 'vfs'],
]);

const messageAliases = new Map<string, string>([
    ['send request', 'req'],
    ['receive response', 'res'],
    ['request skipped: missing identity', 'skip no-id'],
    ['send download request', 'dl req'],
    ['receive download response', 'dl res'],
    ['download skipped: missing identity', 'dl skip no-id'],
    ['connect requested', 'connect req'],
    ['initialize', 'init'],
    ['emit request', 'emit'],
    ['emit timeout', 'emit timeout'],
    ['emit rejected', 'emit reject'],
    ['emit acknowledged', 'emit ok'],
    ['connect failed', 'connect fail'],
    ['force disconnect', 'force disconnect'],
    ['connection rejected', 'reject'],
    ['join project response', 'join ok'],
    ['file created', 'create'],
    ['file renamed', 'rename'],
    ['file removed', 'remove'],
    ['file moved', 'move'],
    ['file content updated', 'ot'],
    ['connection accepted', 'accepted'],
    ['client updated', 'client'],
    ['client disconnected', 'client gone'],
    ['chat message received', 'chat'],
    ['spellcheck language updated', 'spell'],
    ['compiler updated', 'compiler'],
    ['root document updated', 'root-doc'],
    ['remote filesystem disconnected', 'fs disconnect'],
    ['remote filesystem connected', 'fs connect'],
    ['create file requested', 'create req'],
    ['refresh linked file requested', 'refresh linked'],
    ['create linked file requested', 'link create'],
    ['write file requested', 'write req'],
    ['send document update', 'ot send'],
    ['create directory requested', 'mkdir req'],
    ['delete requested', 'delete req'],
    ['rename requested', 'rename req'],
    ['emit file change events', 'events'],
    ['watch registered', 'watch'],
    ['sync bypassed', 'skip'],
    ['sync propagated', 'sync'],
    ['remote watcher event', 'remote event'],
    ['local watcher event bypassed', 'local skip'],
    ['local change was not propagated', 'local skip'],
    ['local watcher event', 'local event'],
    ['watchers initializing', 'watch init'],
]);

const detailKeyAliases: Record<string, string> = {
    action: 'a',
    bytes: 'b',
    column: 'col',
    context: 'ctx',
    create: 'c',
    delay: 'delay',
    docId: 'doc',
    entityId: 'ent',
    error: 'err',
    event: 'ev',
    events: 'events',
    fileType: 'ft',
    folderId: 'folder',
    force: 'force',
    from: 'from',
    language: 'lang',
    localRoot: 'local',
    message: 'msg',
    method: 'm',
    name: 'name',
    newName: 'new',
    opCount: 'ops',
    overwrite: 'ow',
    parentFolderId: 'parent',
    part: 'part',
    path: 'path',
    projectId: 'proj',
    publicId: 'pub',
    query: 'q',
    reason: 'why',
    recursive: 'rec',
    remoteRoot: 'remote',
    route: 'r',
    row: 'row',
    scheme: 'sch',
    server: 'server',
    status: 'st',
    to: 'to',
    type: 't',
    uri: 'uri',
    userId: 'user',
    version: 'v',
};

function getOutputChannel(): vscode.OutputChannel {
    if (outputChannel===undefined) {
        outputChannel = vscode.window.createOutputChannel(ELEGANT_NAME);
    }
    return outputChannel;
}

function compactText(value: string, maxLength = 120): string {
    const normalized = value.replace(/\s+/g, ' ');
    if (normalized.length<=maxLength) {
        return normalized;
    }

    const edgeLength = Math.floor((maxLength - 3) / 2);
    return `${normalized.slice(0, edgeLength)}...${normalized.slice(normalized.length - edgeLength)}`;
}

function valueForLog(value: unknown): string | undefined {
    if (value===undefined) {
        return undefined;
    }
    if (value===null) {
        return 'null';
    }
    if (value instanceof vscode.Uri) {
        return uriForLog(value);
    }
    if (value instanceof Error) {
        return compactText(value.message);
    }
    if (typeof value==='string' || typeof value==='number' || typeof value==='boolean') {
        return compactText(String(value));
    }
    try {
        return compactText(JSON.stringify(value));
    } catch {
        return compactText(String(value));
    }
}

function detailsForLog(details?: Record<string, unknown>): string {
    if (details===undefined) {
        return '';
    }

    const entries = Object.entries(details)
        .map(([key, value]) => {
            const formatted = valueForLog(value);
            return formatted===undefined ? undefined : `${detailKeyAliases[key] ?? key}=${formatted}`;
        })
        .filter((entry): entry is string => entry!==undefined);

    return entries.length>0 ? ` ${entries.join(' ')}` : '';
}

function append(level: LogLevel, scope: string, message: string, details?: Record<string, unknown>) {
    const timestamp = new Date().toTimeString().slice(0, 8);
    getOutputChannel().appendLine(`${timestamp} ${levelAliases[level]} ${scopeAliases.get(scope) ?? scope} ${messageAliases.get(message) ?? message}${detailsForLog(details)}`);
}

export const outputLogger = {
    info: (scope: string, message: string, details?: Record<string, unknown>) => append('info', scope, message, details),
    warn: (scope: string, message: string, details?: Record<string, unknown>) => append('warn', scope, message, details),
    error: (scope: string, message: string, details?: Record<string, unknown>) => append('error', scope, message, details),
};

export function sanitizeRouteForLog(route: string): string {
    return route.replace(/([?&](?:_csrf|csrf|token|auth|password|cookie|session|sid)=)[^&]*/gi, '$1<redacted>');
}

export function uriForLog(uri: vscode.Uri): string {
    if (uri.scheme==='file') {
        return uri.fsPath;
    }
    return uri.with({query: ''}).toString(true);
}

export function fileChangeTypeForLog(type: vscode.FileChangeType): string {
    switch (type) {
        case vscode.FileChangeType.Created:
            return 'created';
        case vscode.FileChangeType.Changed:
            return 'changed';
        case vscode.FileChangeType.Deleted:
            return 'deleted';
        default:
            return `unknown:${type}`;
    }
}

export function fileChangeEventForLog(event: vscode.FileChangeEvent): string {
    return `${fileChangeTypeForLog(event.type)}:${uriForLog(event.uri)}`;
}
