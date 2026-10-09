/** 注入实现归调用者关闭，宿主工厂创建的实现统一登记生命周期。 */
import {
  MessageChannel,
  type ChannelSettings,
  type ChannelProvider,
} from "../packages/channels/channel.js";
import type { Database } from "../packages/persistence/database.js";
import type { IdentityService } from "../packages/identity/service.js";
import type { TaskService } from "../packages/runtime/service.js";
import type { Resources } from "../packages/extensions/registry.js";
import type { Config } from "./config.js";
import { channelProviders } from "./channel-config.js";
export interface ChannelExtension {
  settings: ChannelSettings;
  provider: ChannelProvider;
}
export async function assembleChannels(
  config: Config,
  injected: ChannelExtension[] | undefined,
  db: Database,
  identity: IdentityService,
  tasks: TaskService,
  resources: Resources,
) {
  const entries: ChannelExtension[] = [];
  if (injected) entries.push(...injected);
  else
    for (const account of config.channels ?? []) {
      const provider = await channelProviders.create(
        account.provider,
        account.options,
        config.secrets ??
          (async () => {
            throw new Error("CREDENTIAL_UNAVAILABLE");
          }),
      );
      if (provider.close) resources.add(() => provider.close!());
      entries.push({
        provider,
        settings: {
          ...account,
          identity: [
            account.provider,
            channelProviders.identity(account.provider, account.options)?.key ??
              account.options,
          ],
        },
      });
    }
  if (new Set(entries.map((e) => e.settings.id)).size !== entries.length)
    throw new Error("CHANNEL_ACCOUNT_ID_CONFLICT");
  return entries.map(
    (e) => new MessageChannel(e.settings, e.provider, db, identity, tasks),
  );
}
