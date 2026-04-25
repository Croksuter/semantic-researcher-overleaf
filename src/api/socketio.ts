/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { SocketIOAlt } from './socketioAlt';
import { outputLogger } from '../utils/outputLogger';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

function socketErrorForLog(error: any): string {
    return error instanceof Error ? error.message : error?.message ?? String(error);
}

function socketEmitDetails(event: string, args: any[]): Record<string, unknown> {
    switch (event) {
        case 'joinProject':
            return {projectId: args[0]?.project_id};
        case 'joinDoc':
        case 'leaveDoc':
            return {docId: args[0]};
        case 'applyOtUpdate':
            return {docId: args[0], version: args[1]?.v, opCount: args[1]?.op?.length ?? 0};
        case 'clientTracking.updatePosition':
            return {docId: args[0]?.doc_id, row: args[0]?.row, column: args[0]?.column};
        default:
            return {};
    }
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

type ConnectionScheme = 'Alt' | 'v1' | 'v2';

export class SocketIOAPI {
    private scheme: ConnectionScheme = 'v1';
    private record?: Promise<ProjectEntity>;
    private _handlers: Array<EventsHandler> = [];

    private socket?: any;
    private emit: any;

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        // connect
        outputLogger.info('socket', 'initialize', {
            scheme: this.scheme,
            server: new URL(this.url).host,
            projectId: this.projectId,
        });
        switch(this.scheme) {
            case 'Alt':
                this.socket = new SocketIOAlt(this.url, this.api, this.identity, this.projectId, this.record!);
                break;
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        // create emit
        (this.socket.emit)[require('util').promisify.custom] = (event:string, ...args:any[]) => {
            const details = {scheme: this.scheme, event, ...socketEmitDetails(event, args)};
            outputLogger.info('socket', 'emit request', details);
            let settled = false;
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        outputLogger.warn('socket', 'emit timeout', details);
                        reject('timeout');
                    }
                }, 5000);
            });
            const waitPromise = new Promise((resolve, reject) => {
                this.socket.emit(event, ...args, (err:any, ...data:any[]) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (err) {
                        outputLogger.warn('socket', 'emit rejected', {...details, error: socketErrorForLog(err)});
                        reject(err);
                    } else {
                        outputLogger.info('socket', 'emit acknowledged', details);
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        // this.resumeEventHandlers(this._handlers);
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => {
            outputLogger.info('socket', 'connected', {scheme: this.scheme, projectId: this.projectId});
        });
        this.socket.on('connect_failed', () => {
            outputLogger.warn('socket', 'connect failed', {scheme: this.scheme, projectId: this.projectId});
        });
        this.socket.on('forceDisconnect', (message:string, delay=10) => {
            outputLogger.warn('socket', 'force disconnect', {scheme: this.scheme, projectId: this.projectId, message, delay});
        });
        this.socket.on('connectionRejected', (err:any) => {
            outputLogger.warn('socket', 'connection rejected', {scheme: this.scheme, projectId: this.projectId, error: socketErrorForLog(err)});
        });
        this.socket.on('error', (err:any) => {
            outputLogger.error('socket', 'error', {scheme: this.scheme, projectId: this.projectId, error: socketErrorForLog(err)});
            throw new Error(err);
        });

        if (this.scheme==='v2') {
            this.record = new Promise(resolve => {
                this.socket.on('joinProjectResponse', (res:any) => {
                    const publicId = res.publicId as string;
                    const project = res.project as ProjectEntity;
                    outputLogger.info('server-change', 'join project response', {scheme: this.scheme, projectId: project?._id ?? this.projectId, publicId});
                    EventBus.fire('socketioConnectedEvent', {publicId});
                    resolve(project);
                });
            });
        }
    }

    disconnect() {
        this.socket.disconnect();
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'v1' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler) {
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        outputLogger.info('server-change', 'file created', {type: 'doc', parentFolderId, entityId: doc._id, name: doc.name});
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        outputLogger.info('server-change', 'file created', {type: 'file', parentFolderId, entityId: file._id, name: file.name});
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        outputLogger.info('server-change', 'file created', {type: 'folder', parentFolderId, entityId: folder._id, name: folder.name});
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        outputLogger.info('server-change', 'file renamed', {entityId, newName});
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        outputLogger.info('server-change', 'file removed', {entityId});
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        outputLogger.info('server-change', 'file moved', {entityId, folderId});
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        outputLogger.info('server-change', 'file content updated', {docId: update.doc, version: update.v, opCount: update.op?.length ?? 0});
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        outputLogger.warn('socket', 'disconnected', {scheme: this.scheme, projectId: this.projectId});
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        outputLogger.info('socket', 'connection accepted', {scheme: this.scheme, projectId: this.projectId, publicId});
                        handler(publicId);
                    });
                    EventBus.on('socketioConnectedEvent', (arg:{publicId:string}) => {
                        outputLogger.info('socket', 'connection accepted', {scheme: this.scheme, projectId: this.projectId, publicId: arg.publicId});
                        handler(arg.publicId);
                    });
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        outputLogger.info('server-change', 'client updated', {userId: user.user_id, docId: user.doc_id, row: user.row, column: user.column});
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        outputLogger.info('server-change', 'client disconnected', {clientId: id});
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        outputLogger.info('server-change', 'chat message received', {messageId: message.id, userId: message.user_id});
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        outputLogger.info('server-change', 'spellcheck language updated', {language});
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        outputLogger.info('server-change', 'compiler updated', {compiler});
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        outputLogger.info('server-change', 'root document updated', {rootDocId});
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
    }

    get unSyncFileChanges(): number {
        if (this.socket instanceof SocketIOAlt) {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }

    async syncFileChanges() {
        if (this.socket instanceof SocketIOAlt) {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            setTimeout(() => {
                reject('timeout');
            }, 5000);
        });

        switch(this.scheme) {
            case 'Alt':
            case 'v1':
                const joinPromise = this.emit('joinProject', {project_id})
                .then((returns:[ProjectEntity, string, number]) => {
                    const [project, permissionsLevel, protocolVersion] = returns;
                    this.record = Promise.resolve(project);
                    return project;
                });
                const rejectPromise = new Promise((_, reject) => {
                    this.socket.on('connectionRejected', (err:any) => {
                        this.scheme = 'v2';
                        reject(err.message);
                    });
                });
                return Promise.race([joinPromise, rejectPromise, timeoutPromise]);
            case 'v2':
                return Promise.race([this.record!, timeoutPromise]);
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId:string) {
        return this.emit('joinDoc', docId, { encodeRanges: true })
            .then((returns: [Array<string>, number, Array<any>, any]) => {
                const [docLinesAscii, version, updates, ranges] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.emit('leaveDoc', docId)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        return this.emit('applyOtUpdate', docId, update)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}
