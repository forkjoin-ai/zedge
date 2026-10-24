import { syncZedgeKeychainCredentials } from './zed-credentials.ts';
import {
  syncZedgeLocalProviderCredentials,
  syncZedSettingsModelCatalog,
  type ZedSettingsSyncResult,
} from './zed-settings.ts';
import type { ZedKeychainSyncResult } from './zed-credentials.ts';

export interface ZedProviderAccessSyncResult {
  settings: ZedSettingsSyncResult;
  keychain: ZedKeychainSyncResult;
}

/** Seeds everything Zed actually reads for openai_compatible Zedge (keychain + settings URL/catalog). */
export function syncZedgeProviderAccess(
  port = 7331,
  modelIds?: Iterable<string>,
  preferredModelId?: string
): ZedProviderAccessSyncResult {
  const settings = syncZedgeLocalProviderCredentials(port);
  const keychain = syncZedgeKeychainCredentials(port);
  const preferred =
    preferredModelId?.trim() ||
    process.env.ZEDGE_MOONSHINE_MODEL?.trim() ||
    undefined;

  if (modelIds !== undefined) {
    const catalog = syncZedSettingsModelCatalog(modelIds, port, preferred);
    return {
      settings: {
        updatedPaths: [...new Set([...settings.updatedPaths, ...catalog.updatedPaths])],
        matchedPaths: [...new Set([...settings.matchedPaths, ...catalog.matchedPaths])],
      },
      keychain,
    };
  }

  return { settings, keychain };
}
