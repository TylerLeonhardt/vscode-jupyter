// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

/* eslint-disable , @typescript-eslint/no-explicit-any, @typescript-eslint/no-extraneous-class */

import { inject, injectable } from 'inversify';
import {
    Disposable,
    Event,
    QuickInput,
    QuickInputButton,
    QuickInputButtons,
    QuickPickItem,
    QuickPickItemButtonEvent
} from 'vscode';
import { IApplicationShell } from '../application/types';

// Borrowed from https://github.com/Microsoft/vscode-extension-samples/blob/master/quickinput-sample/src/multiStepInput.ts
// Why re-invent the wheel :)

export class InputFlowAction {
    public static back = new InputFlowAction();
    public static cancel = new InputFlowAction();
    public static resume = new InputFlowAction();
}

export type InputStep<T extends any> = (input: MultiStepInput<T>, state: T) => Promise<InputStep<T> | void>;

export interface IQuickPickParameters<T extends QuickPickItem> {
    title?: string;
    step?: number;
    totalSteps?: number;
    canGoBack?: boolean;
    items: T[];
    activeItem?: T;
    placeholder: string;
    buttons?: QuickInputButton[];
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    acceptFilterBoxTextAsSelection?: boolean;
    shouldResume?(): Promise<boolean>;
    onDidTriggerItemButton?(e: QuickPickItemButtonEvent<T>): void;
    onDidChangeItems?: Event<T[]>;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export interface InputBoxParameters {
    title: string;
    password?: boolean;
    step?: number;
    totalSteps?: number;
    value: string;
    prompt: string;
    buttons?: QuickInputButton[];
    validate(value: string): Promise<string | undefined>;
    shouldResume?(): Promise<boolean>;
}

type MultiStepInputQuickPicResponseType<T, P> = T | (P extends { buttons: (infer I)[] } ? I : never);
type MultiStepInputInputBoxResponseType<P> = string | (P extends { buttons: (infer I)[] } ? I : never);
export interface IMultiStepInput<S> {
    run(start: InputStep<S>, state: S): Promise<void>;
    showQuickPick<T extends QuickPickItem, P extends IQuickPickParameters<T>>({
        title,
        step,
        totalSteps,
        items,
        activeItem,
        placeholder,
        buttons,
        shouldResume
    }: P): Promise<MultiStepInputQuickPicResponseType<T, P>>;
    showInputBox<P extends InputBoxParameters>({
        title,
        step,
        totalSteps,
        value,
        prompt,
        validate,
        buttons,
        shouldResume
    }: P): Promise<MultiStepInputInputBoxResponseType<P>>;
}

export class MultiStepInput<S> implements IMultiStepInput<S> {
    private current?: QuickInput;
    private steps: InputStep<S>[] = [];
    constructor(private readonly shell: IApplicationShell) {}
    public run(start: InputStep<S>, state: S) {
        return this.stepThrough(start, state);
    }

    public async showQuickPick<T extends QuickPickItem, P extends IQuickPickParameters<T>>({
        title,
        step,
        totalSteps,
        items,
        activeItem,
        placeholder,
        buttons,
        shouldResume,
        matchOnDescription,
        matchOnDetail,
        acceptFilterBoxTextAsSelection,
        onDidTriggerItemButton,
        onDidChangeItems
    }: P): Promise<MultiStepInputQuickPicResponseType<T, P>> {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<MultiStepInputQuickPicResponseType<T, P>>((resolve, reject) => {
                const input = this.shell.createQuickPick<T>();
                input.title = title;
                input.step = step;
                input.totalSteps = totalSteps;
                input.placeholder = placeholder;
                input.ignoreFocusOut = true;
                input.items = items;
                if (onDidChangeItems) {
                    input.keepScrollPosition = true;
                    onDidChangeItems(
                        (newItems) => {
                            input.items = newItems;
                        },
                        this,
                        disposables
                    );
                }
                if (onDidTriggerItemButton) {
                    input.onDidTriggerItemButton((e) => onDidTriggerItemButton(e), undefined, disposables);
                }
                input.matchOnDescription = matchOnDescription || false;
                input.matchOnDetail = matchOnDetail || false;
                if (activeItem) {
                    input.activeItems = [activeItem];
                } else {
                    input.activeItems = [];
                }
                input.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : []), ...(buttons || [])];
                disposables.push(
                    input.onDidTriggerButton((item) => {
                        if (item === QuickInputButtons.Back) {
                            reject(InputFlowAction.back);
                        } else {
                            resolve(<any>item);
                        }
                    }),
                    input.onDidChangeSelection((selectedItems) => resolve(selectedItems[0])),
                    input.onDidHide(() => {
                        (async () => {
                            reject(
                                shouldResume && (await shouldResume()) ? InputFlowAction.resume : InputFlowAction.cancel
                            );
                        })().catch(reject);
                    })
                );
                if (acceptFilterBoxTextAsSelection) {
                    disposables.push(
                        input.onDidAccept(() => {
                            resolve(<any>input.value);
                        })
                    );
                }
                if (this.current) {
                    this.current.dispose();
                }
                this.current = input;
                this.current.show();
            });
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    }

    public async showInputBox<P extends InputBoxParameters>({
        title,
        step,
        totalSteps,
        value,
        prompt,
        validate,
        password,
        buttons,
        shouldResume
    }: P): Promise<MultiStepInputInputBoxResponseType<P>> {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<MultiStepInputInputBoxResponseType<P>>((resolve, reject) => {
                const input = this.shell.createInputBox();
                input.title = title;
                input.step = step;
                input.totalSteps = totalSteps;
                input.password = password ? true : false;
                input.value = value || '';
                input.prompt = prompt;
                input.ignoreFocusOut = true;
                input.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : []), ...(buttons || [])];
                disposables.push(
                    input.onDidTriggerButton((item) => {
                        if (item === QuickInputButtons.Back) {
                            reject(InputFlowAction.back);
                        } else {
                            resolve(<any>item);
                        }
                    }),
                    input.onDidAccept(async () => {
                        const inputValue = input.value;
                        input.enabled = false;
                        input.busy = true;
                        const validationMessage = await validate(inputValue);
                        if (!validationMessage) {
                            input.validationMessage = '';
                            resolve(inputValue);
                        } else {
                            input.validationMessage = validationMessage;
                        }
                        input.enabled = true;
                        input.busy = false;
                    }),
                    input.onDidChangeValue(async () => {
                        // Validation happens on acceptance. Just clear as the user types
                        input.validationMessage = '';
                    }),
                    input.onDidHide(() => {
                        (async () => {
                            // If we are busy we might be validating, which might pop up new UI like the password UI, which triggers a hide here
                            // In that case don't reject, promise can wait and continue after validation is done
                            if (!input.busy) {
                                reject(
                                    shouldResume && (await shouldResume())
                                        ? InputFlowAction.resume
                                        : InputFlowAction.cancel
                                );
                            }
                        })().catch(reject);
                    })
                );
                if (this.current) {
                    this.current.dispose();
                }
                this.current = input;
                this.current.show();
            });
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    }

    private async stepThrough(start: InputStep<S>, state: S) {
        let step: InputStep<S> | void = start;
        while (step) {
            this.steps.push(step);
            if (this.current) {
                this.current.enabled = false;
                this.current.busy = true;
            }
            try {
                step = await step(this, state);
            } catch (err) {
                if (err === InputFlowAction.back) {
                    this.steps.pop();
                    step = this.steps.pop();
                } else if (err === InputFlowAction.resume) {
                    step = this.steps.pop();
                } else if (err === InputFlowAction.cancel) {
                    step = undefined;
                } else {
                    throw err;
                }
            }
        }
        if (this.current) {
            this.current.dispose();
        }
    }
}
export const IMultiStepInputFactory = Symbol('IMultiStepInputFactory');
export interface IMultiStepInputFactory {
    create<S>(): IMultiStepInput<S>;
}
@injectable()
export class MultiStepInputFactory {
    constructor(@inject(IApplicationShell) private readonly shell: IApplicationShell) {}
    public create<S>(): IMultiStepInput<S> {
        return new MultiStepInput<S>(this.shell);
    }
}
