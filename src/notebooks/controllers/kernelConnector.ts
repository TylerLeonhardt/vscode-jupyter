/* eslint-disable @typescript-eslint/no-explicit-any */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import {
    IKernel,
    KernelConnectionMetadata,
    IKernelProvider,
    isLocalConnection,
    KernelInterpreterDependencyResponse,
    KernelAction,
    KernelActionSource
} from '../../kernels/types';
import { Memento, NotebookDocument, NotebookController, Uri } from 'vscode';
import { ICommandManager, IApplicationShell } from '../../platform/common/application/types';
import { traceVerbose, traceWarning } from '../../platform/logging';
import { Resource, IMemento, GLOBAL_MEMENTO, IDisplayOptions, IDisposable } from '../../platform/common/types';
import { createDeferred, createDeferredFromPromise, Deferred } from '../../platform/common/utils/async';
import { DataScience } from '../../platform/common/utils/localize';
import { sendKernelTelemetryEvent } from '../../telemetry/telemetry';
import { IServiceContainer } from '../../platform/ioc/types';
import { Telemetry, Commands } from '../../webviews/webview-side/common/constants';
import { clearInstalledIntoInterpreterMemento } from '../../kernels/installer/productInstaller';
import { Product } from '../../kernels/installer/types';
import { INotebookControllerManager, INotebookEditorProvider } from '../types';
import { selectKernel } from './kernelSelector';
import { KernelDeadError } from '../../platform/errors/kernelDeadError';
import { noop } from '../../platform/common/utils/misc';
import { IDataScienceErrorHandler } from '../../platform/errors/types';
import { IStatusProvider } from '../../platform/progress/types';
import { IRawNotebookProvider } from '../../kernels/raw/types';
import { IVSCodeNotebookController } from './types';
import { getDisplayNameOrNameOfKernelConnection } from '../../kernels/helpers';
import { isCancellationError } from '../../platform/common/cancellation';

/**
 * Class used for connecting a controller to an instance of an IKernel
 */
export class KernelConnector {
    private static async switchController(
        resource: Resource,
        serviceContainer: IServiceContainer
    ): Promise<{ controller: NotebookController; metadata: KernelConnectionMetadata } | undefined> {
        const commandManager = serviceContainer.get<ICommandManager>(ICommandManager);
        const notebookEditorProvider = serviceContainer.get<INotebookEditorProvider>(INotebookEditorProvider);
        const editor = notebookEditorProvider.findNotebookEditor(resource);

        // Listen for selection change events (may not fire if user cancels)
        const controllerManager = serviceContainer.get<INotebookControllerManager>(INotebookControllerManager);
        let controller: IVSCodeNotebookController | undefined;
        const waitForSelection = createDeferred<IVSCodeNotebookController>();
        const disposable = controllerManager.onNotebookControllerSelected((e) =>
            waitForSelection.resolve(e.controller)
        );

        const selected = await selectKernel(resource, serviceContainer.get(INotebookEditorProvider), commandManager);
        if (selected && editor) {
            controller = await waitForSelection.promise;
        }
        disposable.dispose();
        return controller ? { controller: controller.controller, metadata: controller.connection } : undefined;
    }

    private static async notifyAndRestartDeadKernel(
        kernel: IKernel,
        serviceContainer: IServiceContainer
    ): Promise<boolean> {
        const appShell = serviceContainer.get<IApplicationShell>(IApplicationShell);
        const commandManager = serviceContainer.get<ICommandManager>(ICommandManager);
        // Status provider may not be available in web situation
        const statusProvider = serviceContainer.tryGet<IStatusProvider>(IStatusProvider);

        const selection = await appShell.showErrorMessage(
            DataScience.cannotRunCellKernelIsDead().format(
                getDisplayNameOrNameOfKernelConnection(kernel.kernelConnectionMetadata)
            ),
            { modal: true },
            DataScience.showJupyterLogs(),
            DataScience.restartKernel()
        );
        let restartedKernel = false;
        switch (selection) {
            case DataScience.restartKernel(): {
                // Set our status
                const status = statusProvider?.set(DataScience.restartingKernelStatus());
                try {
                    await kernel.restart();
                    restartedKernel = true;
                } finally {
                    status?.dispose();
                }
                break;
            }
            case DataScience.showJupyterLogs(): {
                commandManager.executeCommand(Commands.ViewJupyterOutput).then(noop, noop);
            }
        }
        return restartedKernel;
    }

    private static async handleKernelError(
        serviceContainer: IServiceContainer,
        error: Error,
        errorContext: KernelAction,
        resource: Resource,
        kernel: IKernel,
        controller: NotebookController,
        metadata: KernelConnectionMetadata,
        actionSource: KernelActionSource
    ) {
        const memento = serviceContainer.get<Memento>(IMemento, GLOBAL_MEMENTO);
        // Error handler may not be available in web situation
        const errorHandler = serviceContainer.get<IDataScienceErrorHandler>(IDataScienceErrorHandler);

        if (metadata.interpreter && errorContext === 'start') {
            // If we failed to start the kernel, then clear cache used to track
            // whether we have dependencies installed or not.
            // Possible something is missing.
            clearInstalledIntoInterpreterMemento(memento, Product.ipykernel, metadata.interpreter.uri).ignoreErrors();
        }

        const handleResult = await errorHandler.handleKernelError(
            error,
            errorContext,
            metadata,
            resource,
            actionSource
        );

        // Send telemetry for handling the error (if raw)
        const isLocal = isLocalConnection(metadata);

        // Raw notebook provider is not available in web
        const rawNotebookProvider = serviceContainer.tryGet<IRawNotebookProvider>(IRawNotebookProvider);
        const rawLocalKernel = rawNotebookProvider?.isSupported && isLocal;
        if (rawLocalKernel && errorContext === 'start') {
            sendKernelTelemetryEvent(resource, Telemetry.RawKernelSessionStartNoIpykernel, {
                reason: handleResult
            });
        }

        // Dispose the kernel no matter what happened as we need to go around again when there's an error
        kernel.dispose().ignoreErrors();

        switch (handleResult) {
            case KernelInterpreterDependencyResponse.cancel:
            case KernelInterpreterDependencyResponse.failed:
                throw error;

            case KernelInterpreterDependencyResponse.selectDifferentKernel: {
                // Loop around and create the new one. The user wants to switch

                // Update to the selected controller
                const result = await KernelConnector.switchController(resource, serviceContainer);
                if (!result) {
                    throw error;
                }
                controller = result.controller;
                metadata = result.metadata;
                break;
            }
        }

        return { controller, metadata };
    }

    private static convertContextToFunction(currentContext: KernelAction, options?: IDisplayOptions) {
        switch (currentContext) {
            case 'start':
            case 'execution':
                return (k: IKernel) => k.start(options);

            case 'interrupt':
                return (k: IKernel) => k.interrupt();

            case 'restart':
                return (k: IKernel) => k.restart();
        }
    }

    private static connectionsByNotebook = new WeakMap<
        NotebookDocument,
        {
            kernel: Deferred<{
                kernel: IKernel;
                deadKernelAction?: 'deadKernelWasRestarted' | 'deadKernelWasNoRestarted';
            }>;
            options: IDisplayOptions;
        }
    >();
    private static connectionsByUri = new Map<
        string,
        {
            kernel: Deferred<{
                kernel: IKernel;
                deadKernelAction?: 'deadKernelWasRestarted' | 'deadKernelWasNoRestarted';
            }>;
            options: IDisplayOptions;
        }
    >();

    private static async verifyKernelState(
        serviceContainer: IServiceContainer,
        notebookResource: NotebookResource,
        options: IDisplayOptions,
        promise: Promise<{
            kernel: IKernel;
            deadKernelAction?: 'deadKernelWasRestarted' | 'deadKernelWasNoRestarted';
        }>,
        actionSource: KernelActionSource,
        onAction: (action: KernelAction, kernel: IKernel) => void,
        disposables: IDisposable[]
    ): Promise<IKernel> {
        const { kernel, deadKernelAction } = await promise;
        // Before returning, but without disposing the kernel, double check it's still valid
        // If a restart didn't happen, then we can't connect. Throw an error.
        // Do this outside of the loop so that subsequent calls will still ask because the kernel isn't disposed
        if (kernel.status === 'dead' || (kernel.status === 'terminating' && !kernel.disposed && !kernel.disposing)) {
            // If the kernel is dead, then remove the cached promise, & try to get the kernel again.
            // At that point, it will get restarted.
            this.deleteKernelInfo(notebookResource, promise);
            if (deadKernelAction === 'deadKernelWasNoRestarted') {
                throw new KernelDeadError(kernel.kernelConnectionMetadata);
            } else if (deadKernelAction === 'deadKernelWasRestarted') {
                return kernel;
            }
            // Kernel is dead and we didn't prompt the user to restart it, hence re-run the code that will prompt the user for a restart.
            return KernelConnector.wrapKernelMethod(
                kernel.controller,
                kernel.kernelConnectionMetadata,
                'start',
                actionSource,
                serviceContainer,
                notebookResource,
                options,
                disposables,
                onAction
            );
        }
        return kernel;
    }

    public static async wrapKernelMethod(
        controller: NotebookController,
        metadata: KernelConnectionMetadata,
        initialContext: KernelAction,
        actionSource: KernelActionSource,
        serviceContainer: IServiceContainer,
        notebookResource: NotebookResource,
        options: IDisplayOptions,
        disposables: IDisposable[],
        onAction: (action: KernelAction, kernel: IKernel) => void = () => noop()
    ): Promise<IKernel> {
        traceVerbose(`${initialContext} the kernel, options.disableUI=${options.disableUI}`);

        let currentPromise = this.getKernelInfo(notebookResource);
        if (!options.disableUI && currentPromise?.options.disableUI) {
            currentPromise.options.disableUI = false;
        }
        // If the current kernel has been disposed or in the middle of being disposed, then create another one.
        // But do that only if we require a UI, else we can just use the current one.
        if (
            !options.disableUI &&
            currentPromise?.kernel.resolved &&
            (currentPromise?.kernel.value?.kernel?.disposed || currentPromise?.kernel.value?.kernel?.disposing)
        ) {
            this.deleteKernelInfo(notebookResource);
            currentPromise = undefined;
        }

        // Wrap the kernel method again to interrupt/restart this kernel.
        if (currentPromise && initialContext !== 'restart' && initialContext !== 'interrupt') {
            return KernelConnector.verifyKernelState(
                serviceContainer,
                notebookResource,
                options,
                currentPromise.kernel.promise,
                actionSource,
                onAction,
                disposables
            );
        }

        const promise = KernelConnector.wrapKernelMethodImpl(
            controller,
            metadata,
            initialContext,
            serviceContainer,
            notebookResource,
            options,
            actionSource,
            onAction
        );
        const deferred = createDeferredFromPromise(promise);
        deferred.promise.catch(noop);
        // If the kernel gets disposed or we fail to create the kernel, then ensure we remove the cached result.
        promise
            .then((result) => {
                result.kernel.onDisposed(
                    () => {
                        this.deleteKernelInfo(notebookResource, deferred.promise);
                    },
                    undefined,
                    disposables
                );
            })
            .catch(() => {
                this.deleteKernelInfo(notebookResource, deferred.promise);
            });

        this.setKernelInfo(notebookResource, deferred, options);
        return KernelConnector.verifyKernelState(
            serviceContainer,
            notebookResource,
            options,
            deferred.promise,
            actionSource,
            onAction,
            disposables
        );
    }
    private static getKernelInfo(notebookResource: NotebookResource) {
        return notebookResource.notebook
            ? KernelConnector.connectionsByNotebook.get(notebookResource.notebook)
            : KernelConnector.connectionsByUri.get(notebookResource.resource.toString());
    }
    private static setKernelInfo(
        notebookResource: NotebookResource,
        deferred: Deferred<{
            kernel: IKernel;
            deadKernelAction?: 'deadKernelWasRestarted' | 'deadKernelWasNoRestarted' | undefined;
        }>,
        options: IDisplayOptions
    ) {
        if (notebookResource.notebook) {
            KernelConnector.connectionsByNotebook.set(notebookResource.notebook, { kernel: deferred, options });
        } else {
            KernelConnector.connectionsByUri.set(notebookResource.resource.toString(), { kernel: deferred, options });
        }
    }
    private static deleteKernelInfo(
        notebookResource: NotebookResource,
        matchingKernelPromise?: Promise<{
            kernel: IKernel;
            deadKernelAction?: 'deadKernelWasRestarted' | 'deadKernelWasNoRestarted' | undefined;
        }>
    ) {
        if (!matchingKernelPromise) {
            if (notebookResource.notebook) {
                KernelConnector.connectionsByNotebook.delete(notebookResource.notebook);
            } else {
                KernelConnector.connectionsByUri.delete(notebookResource.resource.toString());
            }
            return;
        }
        if (
            notebookResource.notebook &&
            KernelConnector.connectionsByNotebook.get(notebookResource.notebook)?.kernel.promise ===
                matchingKernelPromise
        ) {
            KernelConnector.connectionsByNotebook.delete(notebookResource.notebook);
        } else if (
            notebookResource.resource &&
            KernelConnector.connectionsByUri.get(notebookResource.resource.toString())?.kernel.promise ===
                matchingKernelPromise
        ) {
            KernelConnector.connectionsByUri.delete(notebookResource.resource.toString());
        }
    }

    private static async wrapKernelMethodImpl(
        controller: NotebookController,
        metadata: KernelConnectionMetadata,
        initialContext: KernelAction,
        serviceContainer: IServiceContainer,
        notebookResource: NotebookResource,
        options: IDisplayOptions,
        actionSource: KernelActionSource,
        onAction: (action: KernelAction, kernel: IKernel) => void
    ): Promise<{
        kernel: IKernel;
        deadKernelAction?: 'deadKernelWasRestarted' | 'deadKernelWasNoRestarted';
    }> {
        const kernelProvider = serviceContainer.get<IKernelProvider>(IKernelProvider);
        let kernel: IKernel | undefined;
        let currentMethod = KernelConnector.convertContextToFunction(initialContext, options);
        let currentContext = initialContext;
        while (kernel === undefined) {
            // Try to create the kernel (possibly again)
            kernel = kernelProvider.getOrCreate(
                notebookResource.notebook ? notebookResource.notebook.uri : notebookResource.resource,
                {
                    metadata,
                    controller,
                    resourceUri: notebookResource.resource,
                    creator: actionSource
                }
            );

            const isKernelDead = (k: IKernel) =>
                k.status === 'dead' || (k.status === 'terminating' && !k.disposed && !k.disposing);

            try {
                // If the kernel is dead, ask the user if they want to restart.
                // We need to perform this check first, as its possible we'd call this method for dead kernels.
                // & if the kernel is dead, prompt to restart.
                if (initialContext !== 'restart' && isKernelDead(kernel) && !options.disableUI) {
                    const restarted = await KernelConnector.notifyAndRestartDeadKernel(kernel, serviceContainer);
                    return {
                        kernel,
                        deadKernelAction: restarted ? 'deadKernelWasRestarted' : 'deadKernelWasNoRestarted'
                    };
                } else {
                    onAction(currentContext, kernel);
                    await currentMethod(kernel);

                    // If the kernel is dead, ask the user if they want to restart
                    if (isKernelDead(kernel) && !options.disableUI) {
                        await KernelConnector.notifyAndRestartDeadKernel(kernel, serviceContainer);
                    }
                }
            } catch (error) {
                if (!isCancellationError(error)) {
                    traceWarning(
                        `Error occurred while trying to ${currentContext} the kernel, options.disableUI=${options.disableUI}`,
                        error
                    );
                }
                if (options.disableUI) {
                    throw error;
                }
                const result = await KernelConnector.handleKernelError(
                    serviceContainer,
                    error,
                    currentContext,
                    notebookResource.resource,
                    kernel,
                    controller,
                    metadata,
                    actionSource
                );
                controller = result.controller;
                metadata = result.metadata;
                // When we wrap around, update the current method to start. This
                // means if we're handling a restart or an interrupt that fails, we move onto trying to start the kernel.
                currentMethod = (k) => k.start(options);
                currentContext = 'start';

                if (actionSource === '3rdPartyExtension') {
                    // Rethrow the error to the 3rd party caller & do not retry.
                    throw error;
                } else {
                    // Since an error occurred, we have to try again (controller may have switched so we have to pick a new kernel)
                    kernel = undefined;
                }
            }
        }
        return { kernel };
    }

    public static async connectToKernel(
        controller: NotebookController,
        metadata: KernelConnectionMetadata,
        serviceContainer: IServiceContainer,
        notebookResource: NotebookResource,
        options: IDisplayOptions,
        disposables: IDisposable[],
        actionSource: KernelActionSource = 'jupyterExtension',
        onAction: (action: KernelAction, kernel: IKernel) => void = () => noop()
    ): Promise<IKernel> {
        return KernelConnector.wrapKernelMethod(
            controller,
            metadata,
            'start',
            actionSource,
            serviceContainer,
            notebookResource,
            options,
            disposables,
            onAction
        );
    }
}

type NotebookResource = { resource: Resource; notebook: NotebookDocument } | { resource: Uri; notebook: undefined };
