// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import type * as nbformat from '@jupyterlab/nbformat';
import * as uriPath from '../../platform/vscode-path/resources';
import { SemVer, parse } from 'semver';
import { NotebookData, NotebookDocument, TextDocument, Uri, workspace } from 'vscode';
import { sendTelemetryEvent } from '../../telemetry';
import { getTelemetrySafeLanguage } from '../../telemetry/helpers';
import { splitMultilineString } from '../../webviews/webview-side/common';

import {
    InteractiveWindowView,
    jupyterLanguageToMonacoLanguageMapping,
    JupyterNotebookView,
    PYTHON_LANGUAGE,
    Telemetry
} from './constants';
import { traceError, traceInfo } from '../logging';

import { ICell } from './types';
import { DataScience } from './utils/localize';
import { IJupyterKernelSpec } from '../api/extension';

// Can't figure out a better way to do this. Enumerate
// the allowed keys of different output formats.
const dummyStreamObj: nbformat.IStream = {
    output_type: 'stream',
    name: 'stdout',
    text: ''
};
const dummyErrorObj: nbformat.IError = {
    output_type: 'error',
    ename: '',
    evalue: '',
    traceback: ['']
};
const dummyDisplayObj: nbformat.IDisplayData = {
    output_type: 'display_data',
    data: {},
    metadata: {}
};
const dummyExecuteResultObj: nbformat.IExecuteResult = {
    output_type: 'execute_result',
    execution_count: 0,
    data: {},
    metadata: {}
};
export const AllowedCellOutputKeys = {
    ['stream']: new Set(Object.keys(dummyStreamObj)),
    ['error']: new Set(Object.keys(dummyErrorObj)),
    ['display_data']: new Set(Object.keys(dummyDisplayObj)),
    ['execute_result']: new Set(Object.keys(dummyExecuteResultObj))
};

export function getResourceType(uri?: Uri): 'notebook' | 'interactive' {
    if (!uri) {
        return 'interactive';
    }
    return uriPath.extname(uri).toLowerCase().endsWith('ipynb') ? 'notebook' : 'interactive';
}

function fixupOutput(output: nbformat.IOutput): nbformat.IOutput {
    let allowedKeys: Set<string>;
    switch (output.output_type) {
        case 'stream':
        case 'error':
        case 'execute_result':
        case 'display_data':
            allowedKeys = AllowedCellOutputKeys[output.output_type];
            break;
        default:
            return output;
    }
    const result = { ...output };
    for (const k of Object.keys(output)) {
        if (!allowedKeys.has(k)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (result as any)[k];
        }
    }
    return result;
}

export function pruneCell(cell: nbformat.ICell): nbformat.ICell {
    // Source is usually a single string on input. Convert back to an array
    const result = {
        ...cell,
        source: splitMultilineString(cell.source)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as nbformat.ICell; // nyc (code coverage) barfs on this so just trick it.

    // Remove outputs and execution_count from non code cells
    if (result.cell_type !== 'code') {
        // Map to any so nyc will build.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (<any>result).outputs;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (<any>result).execution_count;
    } else if (result.cell_type) {
        // Clean outputs from code cells
        const cellResult = result as nbformat.ICodeCell;
        cellResult.outputs = cellResult.outputs ? (cellResult.outputs as nbformat.IOutput[]).map(fixupOutput) : [];
    }

    return result;
}

export function traceCellResults(prefix: string, results: ICell[]) {
    if (results.length > 0 && results[0].data.cell_type === 'code') {
        const cell = results[0].data as nbformat.ICodeCell;
        const error = cell.outputs && cell.outputs[0] ? 'evalue' in cell.outputs[0] : undefined;
        if (error) {
            traceError(`${prefix} Error : ${error}`);
        } else if (cell.outputs && cell.outputs[0]) {
            if (cell.outputs[0].output_type.includes('image')) {
                traceInfo(`${prefix} Output: image`);
            } else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const data = (cell.outputs[0] as any).data;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const text = (cell.outputs[0] as any).text;
                traceInfo(`${prefix} Output: ${text || JSON.stringify(data)}`);
            }
        }
    } else {
        traceInfo(`${prefix} no output.`);
    }
}

export function translateKernelLanguageToMonaco(language: string): string {
    language = language.toLowerCase();
    if (language.length === 2 && language.endsWith('#')) {
        return `${language.substring(0, 1)}sharp`;
    }
    return jupyterLanguageToMonacoLanguageMapping.get(language) || language;
}

export function generateNewNotebookUri(
    counter: number,
    rootFolder: string | undefined,
    tmpDir: string,
    forVSCodeNotebooks?: boolean
): Uri {
    // However if there are files already on disk, we should be able to overwrite them because
    // they will only ever be used by 'open' editors. So just use the current counter for our untitled count.
    const fileName = `${DataScience.untitledNotebookFileName()}-${counter}.ipynb`;
    // Turn this back into an untitled
    if (forVSCodeNotebooks) {
        return Uri.file(fileName).with({ scheme: 'untitled', path: fileName });
    } else {
        return Uri.joinPath(rootFolder ? Uri.file(rootFolder) : Uri.file(tmpDir), fileName).with({
            scheme: 'untitled'
        });
    }
}

// For the given string parse it out to a SemVer or return undefined
export function parseSemVer(versionString: string): SemVer | undefined {
    const versionMatch = /^\s*(\d+)\.(\d+)\.(.+)\s*$/.exec(versionString);
    if (versionMatch && versionMatch.length > 2) {
        const major = parseInt(versionMatch[1], 10);
        const minor = parseInt(versionMatch[2], 10);
        const build = parseInt(versionMatch[3], 10);
        return parse(`${major}.${minor}.${build}`, true) ?? undefined;
    }
}

export function sendNotebookOrKernelLanguageTelemetry(
    telemetryEvent: Telemetry.SwitchToExistingKernel | Telemetry.NotebookLanguage,
    language?: string
) {
    language = getTelemetrySafeLanguage(language);
    sendTelemetryEvent(telemetryEvent, undefined, { language });
}

/**
 * Whether this is a Notebook we created/manage/use.
 * Remember, there could be other notebooks such as GitHub Issues nb by VS Code.
 */
export function isJupyterNotebook(document: NotebookDocument): boolean;
// eslint-disable-next-line @typescript-eslint/unified-signatures
export function isJupyterNotebook(viewType: string): boolean;
export function isJupyterNotebook(option: NotebookDocument | string) {
    if (typeof option === 'string') {
        return option === JupyterNotebookView || option === InteractiveWindowView;
    } else {
        return option.notebookType === JupyterNotebookView || option.notebookType === InteractiveWindowView;
    }
}

export function getNotebookMetadata(document: NotebookDocument | NotebookData): nbformat.INotebookMetadata | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notebookContent: undefined | Partial<nbformat.INotebookContent> = document.metadata?.custom as any;
    // Create a clone.
    return JSON.parse(JSON.stringify(notebookContent?.metadata || {}));
}

export function getAssociatedJupyterNotebook(document: TextDocument): NotebookDocument | undefined {
    return workspace.notebookDocuments.find(
        (notebook) => isJupyterNotebook(notebook) && notebook.getCells().some((cell) => cell.document === document)
    );
}

export function isPythonNotebook(metadata?: nbformat.INotebookMetadata) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kernelSpec = metadata?.kernelspec as any as Partial<IJupyterKernelSpec> | undefined;
    if (metadata?.language_info?.name && metadata.language_info.name !== PYTHON_LANGUAGE) {
        return false;
    }

    if (kernelSpec?.name?.includes(PYTHON_LANGUAGE)) {
        return true;
    }

    // Valid notebooks will have a language information in the metadata.
    return kernelSpec?.language === PYTHON_LANGUAGE || metadata?.language_info?.name === PYTHON_LANGUAGE;
}
