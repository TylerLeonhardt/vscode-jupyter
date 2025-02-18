import { injectable } from 'inversify';
import { Resource } from '../types';
import { BaseWorkspaceService } from './workspace.base';
import * as urlPath from '../../vscode-path/resources';
import { getFilePath } from '../platform/fs-paths';

@injectable()
export class WorkspaceService extends BaseWorkspaceService {
    public async computeWorkingDirectory(resource: Resource): Promise<string> {
        if (resource) {
            const filePath = getFilePath(resource);
            if (filePath.includes('.')) {
                return getFilePath(urlPath.dirname(resource));
            } else {
                return filePath;
            }
        }

        resource = this.getWorkspaceFolder(resource)?.uri || this.rootFolder;

        return resource ? getFilePath(resource) : '.';
    }
}
