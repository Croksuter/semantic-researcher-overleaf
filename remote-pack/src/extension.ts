import * as vscode from 'vscode';
import { BrowserLogin, BrowserLoginRequest, BrowserLoginResponse } from './browserLogin';

const remotePackLoginCommand = 'semantic-researcher-overleaf-remote-pack.login';

function assertBrowserLoginRequest(value:unknown): BrowserLoginRequest {
    if (typeof value!=='object' || value===null) {
        throw new Error('Remote Pack login request is missing.');
    }

    const request = value as Partial<BrowserLoginRequest>;
    if (typeof request.serverName!=='string' || request.serverName.length===0) {
        throw new Error('Remote Pack login request is missing serverName.');
    }
    if (typeof request.serverUrl!=='string' || request.serverUrl.length===0) {
        throw new Error('Remote Pack login request is missing serverUrl.');
    }

    return {
        serverName: request.serverName,
        serverUrl: request.serverUrl,
        timeoutSeconds: typeof request.timeoutSeconds==='number' ? request.timeoutSeconds : undefined,
        browserPath: typeof request.browserPath==='string' ? request.browserPath : undefined,
    };
}

export function activate(context:vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(remotePackLoginCommand, async (value:unknown): Promise<BrowserLoginResponse> => {
            const request = assertBrowserLoginRequest(value);
            return BrowserLogin.login(context, request);
        }),
    );
}

export function deactivate() {}
