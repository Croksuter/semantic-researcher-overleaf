import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import {
    getActiveReplicaRoot,
    isLocalReplicaMetadataUri,
    localUriToPath,
    pathToLocalUri,
    readReplicaSettings,
} from '../utils/localReplicaWorkspace';
import {
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_DIR,
    LEGACY_REPLICA_SETTINGS_FILE,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
} from '../consts';
import { stringifyOverleafUri } from '../utils/overleafUri';
import { formatUnknownError } from '../utils/errorMessage';
import { outputLogger, uriForLog } from '../utils/outputLogger';

const IGNORE_SETTING_KEY = 'ignore-patterns';

type FileCache = {date:number, hash:number};
type SyncAction = 'push'|'pull';
type SyncChangeType = 'update'|'delete';
export type LocalReplicaInitialSyncPolicy = 'remote-first'|'local-first';
type LocalReplicaSyncTree = {
    paths: Set<string>;
    directories: Set<string>;
    files: string[];
};

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content===undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private remoteKnownPaths: Set<string> = new Set();
    private syncQueue: Promise<void> = Promise.resolve();
    private initialSyncPolicy: LocalReplicaInitialSyncPolicy = 'remote-first';
    private suppressedDeletes: Map<string, Partial<Record<SyncAction, number>>> = new Map();
    private localReplicaSettings?: {
        uri: string,
        serverName: string,
        enableCompileNPreview: boolean,
        projectName: string,
    };
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async promptInitialSyncPolicy(baseUri: vscode.Uri, projectName: string): Promise<LocalReplicaInitialSyncPolicy|undefined> {
        type PolicyItem = vscode.QuickPickItem & {policy: LocalReplicaInitialSyncPolicy};
        const items: PolicyItem[] = [
            {
                label: vscode.l10n.t('Use Overleaf remote files'),
                description: vscode.l10n.t('Pull Overleaf into the selected local folder.'),
                detail: vscode.l10n.t('Local-only files stay local during attach and are not uploaded immediately.'),
                policy: 'remote-first',
            },
            {
                label: vscode.l10n.t('Use selected local folder'),
                description: vscode.l10n.t('Upload this local folder to Overleaf.'),
                detail: vscode.l10n.t('Remote-only files may be overwritten or deleted.'),
                policy: 'local-first',
            },
        ];
        const selected = await vscode.window.showQuickPick(items, {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Choose initial sync direction'),
            placeHolder: vscode.l10n.t(
                'Select how "{projectName}" should sync with "{path}" first.',
                {projectName, path: baseUri.fsPath},
            ),
        });
        return selected?.policy;
    }

    private static async pathExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    private get settingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_FILE);
    }

    private get legacySettingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_FILE);
    }

    private get settingsDirectoryUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_DIR);
    }

    private async backupLegacySettings() {
        if (!await LocalReplicaSCMProvider.pathExists(this.legacySettingsUri)) {
            return;
        }
        try {
            await vscode.workspace.fs.rename(
                this.legacySettingsUri,
                vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_BACKUP_FILE),
                {overwrite: false},
            );
        } catch {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            try {
                await vscode.workspace.fs.rename(
                    this.legacySettingsUri,
                    vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_DIR, `settings.${timestamp}.overleaf-workshop.json`),
                    {overwrite: false},
                );
            } catch (error) {
                console.warn(`Could not back up legacy local replica settings under ${this.baseUri.toString()}:`, error);
            }
        }
    }

    private async ensureLocalReplicaSettings() {
        const canonicalSettings = {
            'uri': stringifyOverleafUri(this.vfs.origin),
            'serverName': this.vfs.serverName,
            'enableCompileNPreview': true,
            'projectName': this.vfs.projectName,
        };
        let shouldPersist = false;
        try {
            const content = await vscode.workspace.fs.readFile(this.settingsUri);
            const storedSettings = JSON.parse(new TextDecoder().decode(content));
            this.localReplicaSettings = {
                ...canonicalSettings,
            };
            shouldPersist = JSON.stringify(storedSettings)!==JSON.stringify(this.localReplicaSettings);
        } catch (error) {
            this.localReplicaSettings = canonicalSettings;
            shouldPersist = true;
        }
        if (shouldPersist) {
            await this.persistLocalReplicaSettings();
        }
        await this.backupLegacySettings();
        return this.localReplicaSettings;
    }

    private async hasLocalReplicaSettings() {
        try {
            await vscode.workspace.fs.stat(this.settingsUri);
            return true;
        } catch {
            return LocalReplicaSCMProvider.pathExists(this.legacySettingsUri);
        }
    }

    private async persistLocalReplicaSettings() {
        if (this.localReplicaSettings===undefined) { return; }
        await vscode.workspace.fs.createDirectory(this.settingsDirectoryUri);
        await vscode.workspace.fs.writeFile(
            this.settingsUri,
            Buffer.from(JSON.stringify(this.localReplicaSettings, null, 4)),
        );
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async validateExactBaseUri(uri: string): Promise<vscode.Uri> {
        try {
            const baseUri = vscode.Uri.file(uri);
            if (await LocalReplicaSCMProvider.pathExists(baseUri)) {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
            }
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        return pathToLocalUri(path);
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        return localUriToPath(uri);
    }

    public static async readSettings(rootUri?: vscode.Uri): Promise<any | undefined> {
        return readReplicaSettings(rootUri ?? getActiveReplicaRoot());
    }

    public setInitialSyncPolicy(policy: LocalReplicaInitialSyncPolicy) {
        this.initialSyncPolicy = policy;
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(relPath: string, content?: Uint8Array, action?: SyncAction) {
        const date = Date.now();
        const hash = hashCode(content);
        const cache = this.bypassCache.get(relPath) || [undefined,undefined];
        // update the push/pull cache
        if (action==='push') {
            cache[0] = {date, hash};
            cache[1] = cache[1] ?? {date, hash};
        } else if (action==='pull') {
            cache[1] = {date, hash};
            cache[0] = cache[0] ?? {date, hash};
        } else {
            cache[0] = {date, hash};
            cache[1] = {date, hash};
        }
        // write back to the cache
        this.bypassCache.set(relPath, cache as [FileCache,FileCache]);
    }

    private shouldPropagate(action: SyncAction, relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashCode(content);
            // console.log(action, relPath, `[${cache[0].hash}, ${cache[1].hash}]`, thisHash);
            if (action==='push' && cache[0].hash===thisHash) { return false; }
            if (action==='pull' && cache[1].hash===thisHash) { return false; }
            if (cache[0].hash!==cache[1].hash) {
                if (action==='push' && now-cache[0].date<500 || action==='pull' && now-cache[1].date<500) {
                    this.setBypassCache(relPath, content, action);
                    return true;
                }
                this.setBypassCache(relPath, content, action);
                return false;
            }
        }
        this.setBypassCache(relPath, content, action);
        return true;
    }

    private suppressDeletePropagation(action: SyncAction, relPath: string) {
        const entry = this.suppressedDeletes.get(relPath) || {};
        entry[action] = Date.now() + 2000;
        this.suppressedDeletes.set(relPath, entry);
    }

    private shouldSuppressDeletePropagation(action: SyncAction, relPath: string): boolean {
        const entry = this.suppressedDeletes.get(relPath);
        if (entry===undefined) {
            return false;
        }
        const expiresAt = entry[action];
        if (expiresAt===undefined) {
            return false;
        }
        if (Date.now()<=expiresAt) {
            delete entry[action];
            if (entry.push===undefined && entry.pull===undefined) {
                this.suppressedDeletes.delete(relPath);
            }
            return true;
        }
        delete entry[action];
        if (entry.push===undefined && entry.pull===undefined) {
            this.suppressedDeletes.delete(relPath);
        }
        return false;
    }

    private rememberRemoteBaseline(relPath: string, content?: Uint8Array) {
        this.remoteKnownPaths.add(relPath);
        if (content===undefined) {
            delete this.baseCache[relPath];
        } else {
            this.baseCache[relPath] = content;
        }
    }

    private forgetRemoteBaseline(relPath: string) {
        this.remoteKnownPaths.delete(relPath);
        delete this.baseCache[relPath];
    }

    private contentChanged(left?: Uint8Array, right?: Uint8Array): boolean {
        return hashCode(left)!==hashCode(right);
    }

    private async readRemoteFile(relPath: string): Promise<Uint8Array|undefined> {
        try {
            return await vscode.workspace.fs.readFile(this.vfs.pathToUri(relPath));
        } catch {
            return undefined;
        }
    }

    private async ensureLocalDirectoryTarget(relPath: string) {
        const localUri = this.localUri(relPath);
        try {
            const stat = await vscode.workspace.fs.stat(localUri);
            if (stat.type!==vscode.FileType.Directory) {
                this.setBypassCache(relPath, undefined);
                this.suppressDeletePropagation('push', relPath);
                await vscode.workspace.fs.delete(localUri, {recursive:true});
            }
        } catch {
            // Missing paths are created by the caller.
        }
    }

    private async ensureLocalFileTarget(relPath: string) {
        const localUri = this.localUri(relPath);
        try {
            const stat = await vscode.workspace.fs.stat(localUri);
            if (stat.type===vscode.FileType.Directory) {
                this.setBypassCache(relPath, undefined);
                this.suppressDeletePropagation('push', relPath);
                await vscode.workspace.fs.delete(localUri, {recursive:true});
            }
        } catch {
            // Missing paths are created by writeFile().
        }
    }

    private async writeLocalFromRemote(relPath: string, content: Uint8Array) {
        await this.ensureLocalFileTarget(relPath);
        this.setBypassCache(relPath, content);
        await this.writeFile(relPath, content);
    }

    private mergeRemoteChanges(baseContent: Uint8Array, localContent: Uint8Array, remoteContent: Uint8Array) {
        const dmp = new DiffMatchPatch();
        const baseContentStr = new TextDecoder().decode(baseContent);
        const localContentStr = new TextDecoder().decode(localContent);
        const remoteContentStr = new TextDecoder().decode(remoteContent);
        const remotePatches = dmp.patch_make(baseContentStr, remoteContentStr);
        const [mergedContentStr, patchResults] = dmp.patch_apply(remotePatches, localContentStr);
        return {
            mergedContent: new TextEncoder().encode(mergedContentStr),
            success: (patchResults as boolean[]).every(Boolean),
        };
    }

    private async seedLocalOnlyBypass(remotePaths: Set<string>, root: string='/') {
        const queue = [root];
        while (queue.length!==0) {
            const nextRoot = queue.shift()!;
            const localRoot = this.localUri(nextRoot);
            let items: [string, vscode.FileType][];
            try {
                items = await vscode.workspace.fs.readDirectory(localRoot);
            } catch {
                continue;
            }

            for (const [name, type] of items) {
                const relPath = `${nextRoot}${name}`;
                const localUri = this.localUri(relPath);
                if (isLocalReplicaMetadataUri(localUri, this.baseUri) || this.matchIgnorePatterns(relPath)) {
                    continue;
                }
                if (type===vscode.FileType.Directory) {
                    if (!remotePaths.has(relPath)) {
                        this.setBypassCache(relPath, new Uint8Array());
                    }
                    queue.push(`${relPath}/`);
                } else if (type===vscode.FileType.File && !remotePaths.has(relPath)) {
                    this.setBypassCache(relPath, await vscode.workspace.fs.readFile(localUri));
                }
            }
        }
    }

    private async enqueueSync(task: () => Promise<void>) {
        const run = this.syncQueue.then(task, task);
        this.syncQueue = run.catch(error => {
            console.error('Local replica sync failed:', error);
        });
        return run;
    }

    private async collectRemoteTree(root: string, token: vscode.CancellationToken): Promise<LocalReplicaSyncTree|undefined> {
        const tree: LocalReplicaSyncTree = {
            paths: new Set(),
            directories: new Set(),
            files: [],
        };
        const queue: string[] = [root];
        while (queue.length!==0) {
            const nextRoot = queue.shift()!;
            const vfsUri = this.vfs.pathToUri(nextRoot);
            const items = await this.withFileSystemContext(
                'Read remote directory',
                vfsUri,
                () => vscode.workspace.fs.readDirectory(vfsUri),
            );
            if (token.isCancellationRequested) { return undefined; }
            for (const [name, type] of items) {
                const relPath = nextRoot + name;
                if (this.matchIgnorePatterns(relPath)) {
                    continue;
                }
                tree.paths.add(relPath);
                if (type===vscode.FileType.Directory) {
                    tree.directories.add(relPath);
                    queue.push(`${relPath}/`);
                } else if (type===vscode.FileType.File) {
                    tree.files.push(relPath);
                }
            }
        }
        return tree;
    }

    private async collectLocalTree(root: string, token: vscode.CancellationToken): Promise<LocalReplicaSyncTree|undefined> {
        const tree: LocalReplicaSyncTree = {
            paths: new Set(),
            directories: new Set(),
            files: [],
        };
        const queue: string[] = [root];
        while (queue.length!==0) {
            const nextRoot = queue.shift()!;
            const localRoot = this.localUri(nextRoot);
            const items = await this.withFileSystemContext(
                'Read local directory',
                localRoot,
                () => vscode.workspace.fs.readDirectory(localRoot),
            );
            if (token.isCancellationRequested) { return undefined; }
            for (const [name, type] of items) {
                const relPath = nextRoot + name;
                const localUri = this.localUri(relPath);
                if (isLocalReplicaMetadataUri(localUri, this.baseUri) || this.matchIgnorePatterns(relPath)) {
                    continue;
                }
                tree.paths.add(relPath);
                if (type===vscode.FileType.Directory) {
                    tree.directories.add(relPath);
                    queue.push(`${relPath}/`);
                } else if (type===vscode.FileType.File) {
                    tree.files.push(relPath);
                }
            }
        }
        return tree;
    }

    private async pullRemoteTree(
        remoteTree: LocalReplicaSyncTree,
        root: string,
        progress: vscode.Progress<{message?: string; increment?: number}>,
        token: vscode.CancellationToken,
    ): Promise<boolean|undefined> {
        for (const relPath of remoteTree.directories) {
            if (token.isCancellationRequested) { return undefined; }
            const localUri = this.localUri(relPath);
            this.setBypassCache(relPath, new Uint8Array(), 'pull');
            this.rememberRemoteBaseline(relPath);
            await this.ensureLocalDirectoryTarget(relPath);
            await this.withFileSystemContext(
                'Create local directory',
                localUri,
                () => vscode.workspace.fs.createDirectory(localUri),
            );
        }

        const total = remoteTree.files.length;
        for (let i=0; i<total; i++) {
            const relPath = remoteTree.files[i];
            const vfsUri = this.vfs.pathToUri(relPath);
            if (token.isCancellationRequested) { return undefined; }
            progress.report({increment: 100/total, message: relPath});
            const baseContent = this.baseCache[relPath];
            const localContent = await this.readFile(relPath);
            const remoteContent = await this.withFileSystemContext(
                'Read remote file',
                vfsUri,
                () => vscode.workspace.fs.readFile(vfsUri),
            );
            if (baseContent===undefined || localContent===undefined) {
                await this.writeLocalFromRemote(relPath, remoteContent);
            } else {
                const merge = this.contentChanged(baseContent, remoteContent)
                    ? this.mergeRemoteChanges(baseContent, localContent, remoteContent)
                    : undefined;
                const merged = merge?.success===false ? remoteContent : merge?.mergedContent ?? remoteContent;
                if (merge?.success===false) {
                    vscode.window.showWarningMessage(
                        vscode.l10n.t('Remote changes were detected for "{path}". Pulled remote content because automatic merge failed.', {path: relPath}),
                    );
                }
                await this.writeLocalFromRemote(relPath, merged);
            }
            this.rememberRemoteBaseline(relPath, remoteContent);
        }

        await this.seedLocalOnlyBypass(remoteTree.paths, root);
        return true;
    }

    private isDescendantPath(relPath: string, ancestorPath: string): boolean {
        return relPath.startsWith(`${ancestorPath}/`);
    }

    private isDescendantOfAny(relPath: string, ancestorPaths: Iterable<string>): boolean {
        for (const ancestorPath of ancestorPaths) {
            if (this.isDescendantPath(relPath, ancestorPath)) {
                return true;
            }
        }
        return false;
    }

    private sortedDeepestFirst(paths: Iterable<string>): string[] {
        return [...paths].sort((a, b) => {
            const depthDiff = b.split('/').length - a.split('/').length;
            return depthDiff!==0 ? depthDiff : b.length - a.length;
        });
    }

    private async deleteRemotePath(relPath: string) {
        const vfsUri = this.vfs.pathToUri(relPath);
        this.setBypassCache(relPath, undefined, 'push');
        this.suppressDeletePropagation('pull', relPath);
        await this.withFileSystemContext(
            'Delete remote path',
            vfsUri,
            () => vscode.workspace.fs.delete(vfsUri, {recursive:true}),
        );
        this.forgetRemoteBaseline(relPath);
    }

    private async pushLocalTree(
        remoteTree: LocalReplicaSyncTree,
        root: string,
        progress: vscode.Progress<{message?: string; increment?: number}>,
        token: vscode.CancellationToken,
    ): Promise<boolean|undefined> {
        const localTree = await this.collectLocalTree(root, token);
        if (localTree===undefined || token.isCancellationRequested) {
            return undefined;
        }

        const localFiles = new Set(localTree.files);
        const remoteFiles = new Set(remoteTree.files);
        const typeConflicts = [
            ...[...localTree.directories].filter(relPath => remoteFiles.has(relPath)),
            ...[...localFiles].filter(relPath => remoteTree.directories.has(relPath)),
        ];
        const deletedRemoteRoots = new Set<string>();
        for (const relPath of this.sortedDeepestFirst(typeConflicts)) {
            if (token.isCancellationRequested) { return undefined; }
            await this.deleteRemotePath(relPath);
            deletedRemoteRoots.add(relPath);
        }

        for (const relPath of localTree.directories) {
            if (token.isCancellationRequested) { return undefined; }
            const vfsUri = this.vfs.pathToUri(relPath);
            this.setBypassCache(relPath, new Uint8Array(), 'push');
            await this.withFileSystemContext(
                'Create remote directory',
                vfsUri,
                () => vscode.workspace.fs.createDirectory(vfsUri),
            );
            this.rememberRemoteBaseline(relPath);
        }

        const deletePaths = this.sortedDeepestFirst(
            [...remoteTree.paths].filter(relPath =>
                !localTree.paths.has(relPath) && !this.isDescendantOfAny(relPath, deletedRemoteRoots)
            ),
        );
        const total = localTree.files.length + deletePaths.length;
        for (let i=0; i<localTree.files.length; i++) {
            const relPath = localTree.files[i];
            if (token.isCancellationRequested) { return undefined; }
            progress.report({increment: 100/total, message: relPath});
            const localContent = await this.readFile(relPath);
            if (localContent===undefined) {
                continue;
            }
            const vfsUri = this.vfs.pathToUri(relPath);
            this.setBypassCache(relPath, localContent, 'push');
            await this.withFileSystemContext(
                'Write remote file',
                vfsUri,
                () => vscode.workspace.fs.writeFile(vfsUri, localContent),
            );
            this.rememberRemoteBaseline(relPath, localContent);
            await this.readRemoteFile(relPath); // update remote cache
        }

        for (const relPath of deletePaths) {
            if (token.isCancellationRequested) { return undefined; }
            progress.report({increment: 100/total, message: relPath});
            await this.deleteRemotePath(relPath);
        }

        return true;
    }

    private async overwrite(
        policy: LocalReplicaInitialSyncPolicy=this.initialSyncPolicy,
        root: string='/',
    ): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const remoteTree = await this.collectRemoteTree(root, token);
            if (remoteTree===undefined || token.isCancellationRequested) {
                return undefined;
            }
            if (policy==='local-first') {
                return this.pushLocalTree(remoteTree, root, progress, token);
            }
            return this.pullRemoteTree(remoteTree, root, progress, token);
        });
    }

    private bypassSync(action:SyncAction, type:SyncChangeType, relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            outputLogger.info('local-replica', 'sync bypassed', {action, type, path: relPath, reason: 'ignore-pattern'});
            return true;
        }
        if (type==='delete' && this.shouldSuppressDeletePropagation(action, relPath)) {
            outputLogger.info('local-replica', 'sync bypassed', {action, type, path: relPath, reason: 'suppressed-delete'});
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            outputLogger.info('local-replica', 'sync bypassed', {action, type, path: relPath, reason: 'unchanged-or-cached'});
            return true;
        }
        // otherwise, log the synchronization
        outputLogger.info('local-replica', 'sync propagated', {action, type, path: relPath});
        return false;
    }

    private async pushFile(relPath: string, localContent: Uint8Array, vfsUri: vscode.Uri) {
        const baseContent = this.baseCache[relPath];
        const remoteContent = await this.readRemoteFile(relPath);

        if (remoteContent===undefined && baseContent!==undefined) {
            this.forgetRemoteBaseline(relPath);
            this.setBypassCache(relPath, localContent);
            vscode.window.showWarningMessage(
                vscode.l10n.t('Remote deletion was detected for "{path}". Local content was not uploaded to Overleaf.', {path: relPath}),
            );
            return;
        }

        if (remoteContent!==undefined && baseContent===undefined) {
            await this.writeLocalFromRemote(relPath, remoteContent);
            this.rememberRemoteBaseline(relPath, remoteContent);
            return;
        }

        if (remoteContent!==undefined && baseContent!==undefined && this.contentChanged(baseContent, remoteContent)) {
            if (!this.contentChanged(baseContent, localContent)) {
                await this.writeLocalFromRemote(relPath, remoteContent);
                this.rememberRemoteBaseline(relPath, remoteContent);
                return;
            }

            const {mergedContent, success} = this.mergeRemoteChanges(baseContent, localContent, remoteContent);
            if (!success) {
                await this.writeLocalFromRemote(relPath, remoteContent);
                this.rememberRemoteBaseline(relPath, remoteContent);
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Remote changes were detected for "{path}". Pulled remote content instead of overwriting Overleaf.', {path: relPath}),
                );
                return;
            }

            await this.writeLocalFromRemote(relPath, mergedContent);
            await vscode.workspace.fs.writeFile(vfsUri, mergedContent);
            this.rememberRemoteBaseline(relPath, mergedContent);
            await vscode.workspace.fs.readFile(vfsUri); // update remote cache
            return;
        }

        await vscode.workspace.fs.writeFile(vfsUri, localContent);
        this.rememberRemoteBaseline(relPath, localContent);
        await vscode.workspace.fs.readFile(vfsUri); // update remote cache
    }

    private async pushDelete(relPath: string, toUri: vscode.Uri) {
        const baseContent = this.baseCache[relPath];
        const remoteContent = await this.readRemoteFile(relPath);
        if (remoteContent!==undefined && (baseContent===undefined || this.contentChanged(baseContent, remoteContent))) {
            await this.writeLocalFromRemote(relPath, remoteContent);
            this.rememberRemoteBaseline(relPath, remoteContent);
            vscode.window.showWarningMessage(
                vscode.l10n.t('Remote changes were detected for "{path}". Restored remote content instead of deleting it from Overleaf.', {path: relPath}),
            );
            return;
        }

        if (baseContent===undefined && !this.remoteKnownPaths.has(relPath)) {
            return;
        }

        this.suppressDeletePropagation('pull', relPath);
        await vscode.workspace.fs.delete(toUri, {recursive:true});
        this.forgetRemoteBaseline(relPath);
    }

    private async applySync(action:SyncAction, type: SyncChangeType, relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        await (async () => {
            if (type==='delete') {
                const newContent = undefined;
                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                if (action==='push') {
                    await this.pushDelete(relPath, toUri);
                } else {
                    this.forgetRemoteBaseline(relPath);
                    this.suppressDeletePropagation('push', relPath);
                    await vscode.workspace.fs.delete(toUri, {recursive:true});
                }
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    if (action==='pull') {
                        await this.ensureLocalDirectoryTarget(relPath);
                    }
                    await vscode.workspace.fs.createDirectory(toUri);
                    if (action==='push') {
                        this.rememberRemoteBaseline(relPath);
                    }
                }
                else if (stat.type===vscode.FileType.File) {
                    try {
                        const newContent = await vscode.workspace.fs.readFile(fromUri);
                        if (this.bypassSync(action, type, relPath, newContent)) { return; }
                        if (action==='push') {
                            await this.pushFile(relPath, newContent, toUri);
                        } else {
                            await this.writeLocalFromRemote(relPath, newContent);
                            this.rememberRemoteBaseline(relPath, newContent);
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                }
            }
        })();

        this.status = {status: 'idle', message: ''};
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = ('/' + pathParts.join('/'));
        const localUri = this.localUri(relPath);
        outputLogger.info('local-replica', 'remote watcher event', {type, path: relPath, uri: uriForLog(vfsUri)});
        await this.enqueueSync(() => this.applySync('pull', type, relPath, vfsUri, localUri));
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) {
            outputLogger.info('local-replica', 'local watcher event bypassed', {type, uri: uriForLog(localUri), reason: 'metadata'});
            return;
        }
        if (!await this.hasLocalReplicaSettings()) {
            outputLogger.warn('local-replica', 'local change was not propagated', {type, uri: uriForLog(localUri), reason: 'missing-settings'});
            return;
        }
        // get relative path to baseUri
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        outputLogger.info('local-replica', 'local watcher event', {type, path: relPath, uri: uriForLog(localUri)});
        await this.enqueueSync(() => this.applySync('push', type, relPath, localUri, vfsUri));
    }

    public async initializeLocalReplica(policy?: LocalReplicaInitialSyncPolicy) {
        if (policy!==undefined) {
            this.setInitialSyncPolicy(policy);
        }
        await this.ensureLocalReplicaSettings();
        await this.overwrite(this.initialSyncPolicy);
    }

    private async initWatch() {
        await this.initializeLocalReplica();
        outputLogger.info('local-replica', 'watchers initializing', {localRoot: uriForLog(this.baseUri), remoteRoot: uriForLog(this.vfs.origin)});
        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri.path, '**/*' )
        );

        return [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(async uri => await this.syncFromVFS(uri, 'delete')),
            // sync from local to vfs
            this.localWatcher.onDidChange(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidCreate(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidDelete(async uri => await this.syncToVFS(uri, 'delete')),
        ];
    }

    private localUri(relPath: string): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, relPath.replace(/^\/+/, ''));
    }

    private async withFileSystemContext<T>(
        operation: string,
        uri: vscode.Uri,
        task: () => Thenable<T> | Promise<T>,
    ): Promise<T> {
        try {
            return await task();
        } catch (error) {
            throw new Error(`${operation} failed for ${uri.toString()}: ${formatUnknownError(error)}`);
        }
    }

    private async ensureParentDirectory(relPath: string) {
        const pathParts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
        if (pathParts.length<=1) { return; }
        const parentUri = vscode.Uri.joinPath(this.baseUri, ...pathParts.slice(0, -1));
        await this.withFileSystemContext(
            'Create local parent directory',
            parentUri,
            () => vscode.workspace.fs.createDirectory(parentUri),
        );
    }

    async writeFile(relPath: string, content: Uint8Array): Promise<void> {
        await this.ensureParentDirectory(relPath);
        const uri = this.localUri(relPath);
        return this.withFileSystemContext(
            'Write local file',
            uri,
            () => vscode.workspace.fs.writeFile(uri, content),
        );
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = this.localUri(relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., local parent folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
