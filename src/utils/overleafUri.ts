import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';

export function normalizeOverleafQuery(query: string): string {
    if (query==='' || !/%(?:3d|26)/i.test(query)) {
        return query;
    }
    const decoded = decodeURIComponent(query);
    if (!decoded.includes('user=') || !decoded.includes('project=')) {
        throw new Error(`Invalid Overleaf URI query: ${query}`);
    }
    return decoded;
}

export function normalizeOverleafUri(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme!==ROOT_NAME) {
        return uri;
    }
    return uri.with({query: normalizeOverleafQuery(uri.query)});
}

export function stringifyOverleafUri(uri: vscode.Uri): string {
    const normalized = normalizeOverleafUri(uri);
    if (normalized.scheme!==ROOT_NAME) {
        return normalized.toString();
    }

    const baseUri = normalized.with({query: '', fragment: ''}).toString();
    const query = normalizeOverleafQuery(normalized.query);
    const fragment = normalized.fragment==='' ? '' : `#${encodeURIComponent(normalized.fragment)}`;
    return `${baseUri}${query==='' ? '' : `?${query}`}${fragment}`;
}
