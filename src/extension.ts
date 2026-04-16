import * as vscode from 'vscode';
import { ROOT_NAME } from './consts';
import { RemoteFileSystemProvider } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import {
    configureLocalReplicaWorkspace,
    getActiveReplicaOriginUri,
    getActiveReplicaRoot,
    initializeLocalReplicaWorkspace,
    onDidChangeActiveReplicaRoot,
} from './utils/localReplicaWorkspace';

export function activate(context: vscode.ExtensionContext) {
    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );
    configureLocalReplicaWorkspace(context);

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    const syncActiveReplicaProject = async () => {
        const uri = getActiveReplicaOriginUri();
        if (uri?.scheme===ROOT_NAME) {
            await remoteFileSystemProvider.activateProject(uri);
            const rootUri = getActiveReplicaRoot();
            if (rootUri) {
                await vscode.commands.executeCommand(`${ROOT_NAME}.projectSCM.ensureLocalReplicaSCM`, rootUri);
            }
        }
    };

    context.subscriptions.push(
        onDidChangeActiveReplicaRoot(() => {
            void syncActiveReplicaProject();
        }),
    );

    void initializeLocalReplicaWorkspace().then(async () => {
        await syncActiveReplicaProject();
    });
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaEditor`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaCompileEditor`, false);
}
