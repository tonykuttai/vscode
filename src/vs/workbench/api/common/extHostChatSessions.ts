/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { coalesce } from '../../../base/common/arrays.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../base/common/marshallingIds.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IChatAgentRequest, IChatAgentResult } from '../../contrib/chat/common/chatAgents.js';
import { IChatSessionItem } from '../../contrib/chat/common/chatSessionsService.js';
import { ChatAgentLocation } from '../../contrib/chat/common/constants.js';
import { Proxied } from '../../services/extensions/common/proxyIdentifier.js';
import { ChatSessionDto, ExtHostChatSessionsShape, IChatAgentProgressShape, MainContext, MainThreadChatSessionsShape } from './extHost.protocol.js';
import { ChatAgentResponseStream } from './extHostChatAgents2.js';
import { CommandsConverter, ExtHostCommands } from './extHostCommands.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import * as typeConvert from './extHostTypeConverters.js';
import * as extHostTypes from './extHostTypes.js';
import { ExtHostLanguageModels } from './extHostLanguageModels.js';

class ExtHostChatSession {
	private _stream: ChatAgentResponseStream;

	constructor(
		public readonly session: vscode.ChatSession,
		public readonly extension: IExtensionDescription,
		request: IChatAgentRequest,
		public readonly proxy: IChatAgentProgressShape,
		public readonly commandsConverter: CommandsConverter,
		public readonly sessionDisposables: DisposableStore
	) {
		this._stream = new ChatAgentResponseStream(extension, request, proxy, commandsConverter, sessionDisposables);
	}

	get activeResponseStream() {
		return this._stream;
	}

	getActiveRequestStream(request: IChatAgentRequest) {
		return new ChatAgentResponseStream(this.extension, request, this.proxy, this.commandsConverter, this.sessionDisposables);
	}
}

export class ExtHostChatSessions extends Disposable implements ExtHostChatSessionsShape {

	private readonly _proxy: Proxied<MainThreadChatSessionsShape>;
	private readonly _chatSessionItemProviders = new Map<number, { provider: vscode.ChatSessionItemProvider; extension: IExtensionDescription; disposable: DisposableStore }>();
	private readonly _chatSessionContentProviders = new Map<number, { provider: vscode.ChatSessionContentProvider; extension: IExtensionDescription; disposable: DisposableStore }>();
	private _nextChatSessionItemProviderHandle = 0;
	private _nextChatSessionContentProviderHandle = 0;
	private _sessionMap: Map<string, vscode.ChatSessionItem> = new Map();
	private static _sessionHandlePool = 0;

	constructor(
		private readonly commands: ExtHostCommands,
		private readonly _languageModels: ExtHostLanguageModels,
		@IExtHostRpcService private readonly _extHostRpc: IExtHostRpcService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._proxy = this._extHostRpc.getProxy(MainContext.MainThreadChatSessions);

		commands.registerArgumentProcessor({
			processArgument: (arg) => {
				if (arg && arg.$mid === MarshalledId.ChatSessionContext) {
					const id = arg.id;
					const sessionContent = this._sessionMap.get(id);
					if (sessionContent) {
						return sessionContent;
					} else {
						this._logService.warn(`No chat session found for ID: ${id}`);
						return arg;
					}
				}

				return arg;
			}
		});
	}

	registerChatSessionItemProvider(extension: IExtensionDescription, chatSessionType: string, provider: vscode.ChatSessionItemProvider): vscode.Disposable {
		const handle = this._nextChatSessionItemProviderHandle++;
		const disposables = new DisposableStore();

		this._chatSessionItemProviders.set(handle, { provider, extension, disposable: disposables });
		this._proxy.$registerChatSessionItemProvider(handle, chatSessionType);
		if (provider.onDidChangeChatSessionItems) {
			disposables.add(provider.onDidChangeChatSessionItems(() => {
				this._proxy.$onDidChangeChatSessionItems(chatSessionType);
			}));
		}
		return {
			dispose: () => {
				this._chatSessionItemProviders.delete(handle);
				disposables.dispose();
				this._proxy.$unregisterChatSessionItemProvider(handle);
			}
		};
	}

	registerChatSessionContentProvider(extension: IExtensionDescription, chatSessionType: string, provider: vscode.ChatSessionContentProvider): vscode.Disposable {
		const handle = this._nextChatSessionContentProviderHandle++;
		const disposables = new DisposableStore();

		this._chatSessionContentProviders.set(handle, { provider, extension, disposable: disposables });
		this._proxy.$registerChatSessionContentProvider(handle, chatSessionType);

		return new extHostTypes.Disposable(() => {
			this._chatSessionContentProviders.delete(handle);
			disposables.dispose();
			this._proxy.$unregisterChatSessionContentProvider(handle);
		});
	}

	async showChatSession(_extension: IExtensionDescription, chatSessionType: string, sessionId: string, options: vscode.ChatSessionShowOptions | undefined): Promise<void> {
		await this._proxy.$showChatSession(chatSessionType, sessionId, typeConvert.ViewColumn.from(options?.viewColumn));
	}

	async $provideChatSessionItems(handle: number, token: vscode.CancellationToken): Promise<IChatSessionItem[]> {
		const entry = this._chatSessionItemProviders.get(handle);
		if (!entry) {
			this._logService.error(`No provider registered for handle ${handle}`);
			return [];
		}

		const sessions = await entry.provider.provideChatSessionItems(token);
		if (!sessions) {
			return [];
		}

		const response: IChatSessionItem[] = [];
		for (const sessionContent of sessions) {
			if (sessionContent.id) {
				this._sessionMap.set(
					sessionContent.id,
					sessionContent
				);
				response.push({
					id: sessionContent.id,
					label: sessionContent.label,
					iconPath: sessionContent.iconPath
				});
			}
		}
		return response;
	}

	private readonly _extHostChatSessions = new Map<string, { readonly sessionObj: ExtHostChatSession; readonly disposeCts: CancellationTokenSource }>();

	async $provideChatSessionContent(handle: number, id: string, token: CancellationToken): Promise<ChatSessionDto> {
		const provider = this._chatSessionContentProviders.get(handle);
		if (!provider) {
			throw new Error(`No provider for handle ${handle}`);
		}

		const session = await provider.provider.provideChatSessionContent(id, token);

		const sessionDisposables = new DisposableStore();
		const sessionId = ExtHostChatSessions._sessionHandlePool++;
		const chatSession = new ExtHostChatSession(session, provider.extension, {
			sessionId: `${id}.${sessionId}`,
			requestId: 'ongoing',
			agentId: id,
			message: '',
			variables: { variables: [] },
			location: ChatAgentLocation.Panel,
		}, {
			$handleProgressChunk: (requestId, chunks) => {
				return this._proxy.$handleProgressChunk(handle, id, requestId, chunks);
			},
			$handleAnchorResolve: (requestId, requestHandle, anchor) => {
				this._proxy.$handleAnchorResolve(handle, id, requestId, requestHandle, anchor);
			},
		}, this.commands.converter, sessionDisposables);

		const disposeCts = sessionDisposables.add(new CancellationTokenSource());
		this._extHostChatSessions.set(`${handle}_${id}`, { sessionObj: chatSession, disposeCts });

		// Call activeResponseCallback immediately for best user experience
		if (session.activeResponseCallback) {
			Promise.resolve(session.activeResponseCallback(chatSession.activeResponseStream.apiObject, disposeCts.token)).finally(() => {
				// complete
				this._proxy.$handleProgressComplete(handle, id, 'ongoing');
			});
		}

		return {
			id: sessionId + '',
			hasActiveResponseCallback: !!session.activeResponseCallback,
			hasRequestHandler: !!session.requestHandler,
			history: session.history.map(turn => {
				if (turn instanceof extHostTypes.ChatRequestTurn) {
					return { type: 'request' as const, prompt: turn.prompt };
				} else {
					const responseTurn = turn as extHostTypes.ChatResponseTurn2;
					const parts = coalesce(responseTurn.response.map(r => typeConvert.ChatResponsePart.from(r, this.commands.converter, sessionDisposables)));

					return {
						type: 'response' as const,
						parts
					};
				}
			})
		};
	}

	async $disposeChatSessionContent(providerHandle: number, sessionId: string): Promise<void> {
		const key = `${providerHandle}_${sessionId}`;
		const entry = this._extHostChatSessions.get(key);
		if (!entry) {
			this._logService.warn(`No chat session found for ID: ${key}`);
			return;
		}

		entry.disposeCts.cancel();
		entry.sessionObj.sessionDisposables.dispose();
		this._extHostChatSessions.delete(key);
	}

	async $invokeChatSessionRequestHandler(handle: number, id: string, request: IChatAgentRequest, history: any[], token: CancellationToken): Promise<IChatAgentResult> {
		const entry = this._extHostChatSessions.get(`${handle}_${id}`);
		if (!entry || !entry.sessionObj.session.requestHandler) {
			return {};
		}

		const chatRequest = typeConvert.ChatAgentRequest.to(request, undefined, await this.getModelForRequest(request, entry.sessionObj.extension), [], new Map(), entry.sessionObj.extension, this._logService);

		const stream = entry.sessionObj.getActiveRequestStream(request);
		await entry.sessionObj.session.requestHandler(chatRequest, { history: history }, stream.apiObject, token);

		// TODO: do we need to dispose the stream object?
		return {};
	}

	private async getModelForRequest(request: IChatAgentRequest, extension: IExtensionDescription): Promise<vscode.LanguageModelChat> {
		let model: vscode.LanguageModelChat | undefined;
		if (request.userSelectedModelId) {
			model = await this._languageModels.getLanguageModelByIdentifier(extension, request.userSelectedModelId);
		}
		if (!model) {
			model = await this._languageModels.getDefaultLanguageModel(extension);
			if (!model) {
				throw new Error('Language model unavailable');
			}
		}

		return model;
	}
}
