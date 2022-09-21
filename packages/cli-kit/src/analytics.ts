import {hashString} from './string.js'
import * as environment from './environment.js'
import {platformAndArch} from './os.js'
import {version as rubyVersion} from './node/ruby.js'
import {content, debug, token} from './output.js'
import constants from './constants.js'
import * as metadata from './metadata.js'
import {publishEvent, MONORAIL_COMMAND_TOPIC} from './monorail.js'
import {fanoutHooks} from './plugins.js'
import {getPackageManager, packageManagerUsedForCreating} from './node/node-package-manager.js'
import BaseCommand from './node/base-command.js'
import {macAddress} from './environment/local.js'
import {CommandContent} from './node/hooks/prerun.js'
import {localCliPackage} from './node/cli.js'
import {Interfaces} from '@oclif/core'

interface StartOptions {
  commandContent: CommandContent
  args: string[]
  currentTime?: number
  commandClass?: Interfaces.Command.Class | typeof BaseCommand
}

export const start = async ({commandContent, args, currentTime = new Date().getTime(), commandClass}: StartOptions) => {
  let startCommand: string = commandContent.command
  if (commandClass && Object.prototype.hasOwnProperty.call(commandClass, 'analyticsNameOverride')) {
    startCommand = (commandClass as typeof BaseCommand).analyticsNameOverride() ?? commandContent.command
  }

  await metadata.addSensitive(() => ({
    commandStartOptions: {
      startTime: currentTime,
      startCommand,
      startArgs: args,
    },
  }))

  await metadata.addPublic(() => ({
    cmd_all_launcher: packageManagerUsedForCreating(),
    cmd_all_alias_used: commandContent.alias,
    cmd_all_topic: commandContent.topic,
    cmd_all_plugin: commandClass?.plugin?.name,
  }))
}

interface ReportEventOptions {
  config: Interfaces.Config
  errorMessage?: string
}

/**
 * Report an analytics event, sending it off to Monorail -- Shopify's internal analytics service.
 *
 * The payload for an event includes both generic data, and data gathered from installed plug-ins.
 *
 */
export async function reportEvent(options: ReportEventOptions) {
  try {
    const payload = await buildPayload(options)
    if (payload === undefined) {
      // Nothing to log
      return
    }
    if (!environment.local.alwaysLogAnalytics() && environment.local.analyticsDisabled()) {
      debug(content`Skipping command analytics, payload: ${token.json(payload)}`)
      return
    }
    const response = await publishEvent(MONORAIL_COMMAND_TOPIC, payload.public, payload.sensitive)
    if (response.type === 'error') {
      debug(response.message)
    }
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    let message = 'Failed to report usage analytics'
    if (error instanceof Error) {
      message = message.concat(`: ${error.message}`)
    }
    debug(message)
  }
}

const buildPayload = async ({config, errorMessage}: ReportEventOptions) => {
  const {commandStartOptions, ...sensitiveMetadata} = metadata.getAllSensitive()
  if (commandStartOptions === undefined) {
    debug('Unable to log analytics event - no information on executed command')
    return
  }
  const {startCommand, startArgs, startTime} = commandStartOptions
  const currentTime = new Date().getTime()

  const {'@shopify/app': appPublic, ...otherPluginsPublic} = await fanoutHooks(config, 'public_command_metadata', {})
  const {'@shopify/app': appSensitive, ...otherPluginsSensitive} = await fanoutHooks(
    config,
    'sensitive_command_metadata',
    {},
  )

  const environmentData = await getEnvironmentData(config)
  const sensitiveEnvironmentData = await getSensitiveEnvironmentData(config)

  return {
    public: {
      command: startCommand,
      time_start: startTime,
      time_end: currentTime,
      total_time: currentTime - startTime,
      success: errorMessage === undefined,
      cli_version: await constants.versions.cliKit(),
      ruby_version: (await rubyVersion()) || '',
      node_version: process.version.replace('v', ''),
      is_employee: await environment.local.isShopify(),
      ...environmentData,
      ...appPublic,
      ...metadata.getAllPublic(),
    },
    sensitive: {
      args: startArgs.join(' '),
      error_message: errorMessage,
      ...appSensitive,
      ...sensitiveEnvironmentData,
      metadata: JSON.stringify({
        ...sensitiveMetadata,
        extraPublic: {
          ...otherPluginsPublic,
        },
        extraSensitive: {...otherPluginsSensitive},
      }),
    },
  }
}

export async function getEnvironmentData(config: Interfaces.Config) {
  const ciPlatform = environment.local.ciPlatform()

  const pluginNames = getPluginNames(config)
  const shopifyPlugins = pluginNames.filter((plugin) => plugin.startsWith('@shopify/'))

  const {platform, arch} = platformAndArch()

  return {
    uname: `${platform} ${arch}`,
    env_ci: ciPlatform.isCI,
    env_ci_platform: ciPlatform.name,
    env_plugin_installed_any_custom: pluginNames.length !== shopifyPlugins.length,
    env_plugin_installed_shopify: JSON.stringify(shopifyPlugins),
    env_shell: config.shell,
    env_web_ide: environment.local.cloudEnvironment().editor
      ? environment.local.cloudEnvironment().platform
      : undefined,
    env_mac_address_hash: hashString(await macAddress()),
    env_cloud: environment.local.cloudEnvironment().platform,
    env_package_manager: (await localCliPackage()) ? await getPackageManager(process.cwd()) : undefined,
  }
}

async function getSensitiveEnvironmentData(config: Interfaces.Config) {
  return {
    env_mac_address: await environment.local.macAddress(),
    env_plugin_installed_all: JSON.stringify(getPluginNames(config)),
  }
}

function getPluginNames(config: Interfaces.Config) {
  return config.plugins
    .map((plugin) => plugin.name)
    .sort()
    .filter((plugin) => !plugin.startsWith('@oclif/'))
}
