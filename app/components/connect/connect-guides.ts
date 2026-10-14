/*
 * The per-client connect instructions, built from this deployment's connect
 * config (GET /api/v1/connect/config, #415). Pure, so the copy is unit-testable
 * without mounting the component.
 *
 * Marketplace, plugin names and the server URL come from the config; nothing
 * here names a deployment. When the deployment's origin differs from the server
 * a plugin's default build ships with, or that build ships with none (the public
 * Claude plugin), an extra step points the plugin at this deployment.
 *
 * Copy rules (#418): a step says WHAT to do in one short sentence. Reasons and
 * edge cases go in `details` (a collapsed "More detail") or in `troubleshooting`
 * (a collapsed "Trouble connecting?"). Nothing is dropped; it moves.
 */
import {
  claudeMarketplaceArg,
  needsMcpRegistration,
  SERVED_PLUGIN_REF,
  servedPluginSettings,
  type ConnectConfig,
  type ConnectGuideKind,
} from '#shared/connect'

/* A paragraph is a list of inline segments so prose can mix with <code> and
 * <strong> without v-html. Spaces are baked into the string segments. */
export type Segment = string | { code: string } | { strong: string }
export type Paragraph = Segment[]

export interface Step {
  title: string
  /** Where the step happens. Set only when a guide's steps happen in different places. */
  badge?: string
  intro: Paragraph
  commands?: string[]
  notes?: Paragraph[]
  details?: Paragraph[]
}

export interface Guide {
  /* DOM hooks kept from the original account-page cards for smoke/e2e selectors. */
  testid: string
  cmdTestidPrefix: string
  icon: string
  name: string
  accent: string
  lead: Paragraph
  /** One line: what has to be installed first. */
  prerequisites?: Paragraph
  steps: Step[]
  troubleshooting: Paragraph[]
}

type StepBody = Omit<Step, 'title'> & { label: string }

/** Number the steps in order, so an optional step never leaves a gap. */
function numbered(steps: StepBody[]): Step[] {
  return steps.map(({ label, ...s }, i) => ({ ...s, title: `${i + 1}. ${label}` }))
}

/** The scope advice every Claude install step carries. */
const INSTALL_FOR_YOU_DETAIL: Paragraph = [
  { strong: 'Install for you' },
  ' is user scope, so the plugin works in all your repos. Don’t choose project or local scope. A repo carries its own ',
  { code: '.tokenscope' },
  ' file instead.',
]

/** The Git install, as one troubleshooting paragraph (the served marketplace is step 1). */
function claudeGitFallback(c: ConnectConfig, register: boolean): Paragraph {
  return [
    { strong: 'Can’t use the address in step 1?' },
    ' Install from Git instead. This needs Git, and access to ',
    { code: c.marketplaceSource },
    '. If step 1 added the marketplace, run ',
    { code: '/plugin marketplace remove tokenscope' },
    ' first. Then run ',
    { code: `/plugin marketplace add ${claudeMarketplaceArg(c)}` },
    ', then ',
    { code: `/plugin install ${c.claudePlugin}@${c.marketplaceName}` },
    ...(register && c.origin
      ? ([
          '. Then run ',
          { code: '/plugin' },
          ', open tokenscope → Configure options, and set TokenScope server URL to ',
          { code: c.origin },
        ] as Segment[])
      : []),
    '. Then carry on from “Sign in”.',
  ]
}

/* Where the user is working: Claude Code in a terminal, or a Code session in the Claude app. */
type ClaudeSurface = 'cli' | 'desktop'

const APP_NAME: Record<ClaudeSurface, string> = { cli: 'Claude Code', desktop: 'the Claude app' }

/** Sign in, set up, restart, check: the same on both surfaces, bar the wording. */
function claudeAfterInstall(surface: ClaudeSurface): StepBody[] {
  const desktop = surface === 'desktop'
  return [
    {
      label: 'Sign in',
      intro: desktop
        ? ['Run this, choose ', { strong: 'tokenscope' }, ', select ', { strong: 'Connect' }, ', and approve in your browser:']
        : ['Run this, choose ', { strong: 'tokenscope' }, ', and approve in your browser:'],
      commands: ['/mcp'],
      details: [
        [
          'Installing the plugin does not sign you in. Signing in lets the TokenScope tools in Claude Code read your usage and tag sessions. The next step needs it.',
        ],
      ],
    },
    {
      label: 'Turn on tracking',
      intro: ['Run:'],
      commands: ['/tokenscope:setup'],
      notes: [['Don’t skip this. Without it, nothing is tracked.']],
      details: [
        [
          'Setup registers this computer with TokenScope. A helper on your computer saves the credential, so there is nothing to copy, and the credential never passes through the chat.',
        ],
        ...(desktop
          ? [
              [
                'In the Claude app, setup also adds this computer to your login environment. The app ignores the tracking labels in your settings file, but it does pass on the login ones. On Linux they take effect at your next login.',
              ] as Paragraph,
            ]
          : []),
      ],
    },
    {
      label: desktop ? 'Restart the Claude app' : 'Restart Claude Code',
      intro: desktop
        ? ['Quit the Claude app completely, not just its window, and open it again.']
        : ['Quit Claude Code and open it again.'],
      ...(desktop
        ? { notes: [[{ strong: 'Linux:' }, ' log out of your computer and back in instead, then open the app.'] as Paragraph] }
        : {}),
      details: [['Claude Code reads the tracking settings only when it starts.']],
    },
    {
      label: 'Check it works',
      intro: desktop ? ['In a new Code session, run:'] : ['Run:'],
      commands: ['/tokenscope:status'],
      notes: [[{ strong: 'Green' }, ' means you’re done.']],
      details: [
        [
          'Green means this computer is signed in and set up to send usage. It does not prove usage has arrived: that shows in TokenScope about 5 minutes after you use Claude Code.',
        ],
      ],
    },
  ]
}

const CLAUDE_PREREQUISITES: Paragraph = [
  { strong: 'Windows:' },
  ' nothing else to install. ',
  { strong: 'macOS / Linux:' },
  ' needs Node.js.',
]

function windowsWithoutNode(): Paragraph {
  return [
    { strong: 'Windows without Node.js:' },
    ' tracking works, but the status line, ',
    { code: '/tokenscope:backfill' },
    ' and tagging sessions from a repo’s ',
    { code: '.tokenscope' },
    ' file need Node.js. Without it, a plugin update doesn’t update your tracking settings, so run ',
    { code: '/tokenscope:setup' },
    ' again after each update. To get everything, run ',
    { code: 'winget install OpenJS.NodeJS.LTS' },
    ', then ',
    { code: '/tokenscope:setup' },
    ' again.',
  ]
}

function signInCantReturn(surface: ClaudeSurface): Paragraph {
  const app = APP_NAME[surface]
  return [
    { strong: `The browser sign-in can’t get back to ${app}:` },
    ` copy the link the sign-in page shows into ${app}.`,
  ]
}

function statusNotGreen(surface: ClaudeSurface): Paragraph {
  return [
    { strong: 'Status isn’t green:' },
    ` check you restarted ${APP_NAME[surface]}. In a repo with a `,
    { code: '.tokenscope' },
    ' file, restart once more if you see a “superseded device enrolment” warning. If status says to log out and back in, or to restart your computer, do that rather than running setup again. Still not green? Run ',
    { code: '/tokenscope:setup' },
    ' again.',
  ]
}

/** What the Desktop user pastes into a Code session: Claude makes the settings edit. */
export function desktopInstallPrompt(marketplaceUrl: string): string {
  return [
    'Add TokenScope to my Claude Code user settings.',
    'First find the settings file: if the CLAUDE_CONFIG_DIR environment variable is set, use $CLAUDE_CONFIG_DIR/settings.json; otherwise use ~/.claude/settings.json (on Windows, %USERPROFILE%\\.claude\\settings.json). Stop and tell me instead if CLAUDE_CONFIG_DIR is set by this project’s own .claude settings, is not a full path, is my home folder itself, is a file rather than a folder, is outside my home folder, or is inside a git repository: TokenScope will not use such a folder. Tell me which file you are editing before you change it.',
    'Inside "extraKnownMarketplaces", add or replace only the "tokenscope" entry. Inside "enabledPlugins", add only the "tokenscope@tokenscope" entry.',
    'Keep every other entry and key in the file, create the file if it does not exist, and change nothing else. These are the entries:',
    '',
    JSON.stringify(servedPluginSettings(marketplaceUrl), null, 2),
  ].join('\n')
}

function desktopGuide(c: ConnectConfig): Guide {
  const head = {
    testid: 'connect-claude-desktop',
    cmdTestidPrefix: 'desktop-install-cmd',
    icon: 'logos:claude-icon',
    name: 'Claude Desktop',
    accent: '#D97757',
  }
  const served = c.claudeMarketplaceUrl
  // The app adds marketplaces only from Git hosts, and only the served
  // marketplace installs without Git: no served marketplace, no Desktop path.
  if (!served) {
    return {
      ...head,
      lead: [
        'This deployment can’t serve the plugin right now, and without it the Claude app can’t connect to TokenScope. Ask your administrator, or use ',
        { strong: 'Connect Claude Code CLI' },
        ' in a terminal.',
      ],
      steps: [],
      troubleshooting: [],
    }
  }
  const steps: StepBody[] = [
    {
      label: 'Add TokenScope to Claude',
      intro: ['In the Claude app, open a ', { strong: 'local' }, ' Code session and paste this:'],
      commands: [desktopInstallPrompt(served)],
      notes: [
        [
          'First switch the session out of ',
          { strong: 'Auto' },
          ' mode, to one that asks before edits (the mode selector by the message box): Auto mode won’t let Claude change its own settings. Approve the change when Claude asks, then switch back.',
        ],
      ],
      details: [
        [
          'This adds this deployment’s plugin marketplace to your Claude settings. The plugin already points at this deployment. You don’t need Git or a GitHub account.',
        ],
        [
          'If the Claude app keeps its own settings folder (CLAUDE_CONFIG_DIR is set), that folder’s settings.json is the one to change, not ~/.claude/settings.json, which belongs to Claude Code in a terminal.',
        ],
        [
          'Don’t use ',
          { code: '/plugin marketplace add' },
          ' in the app: its form accepts only Git hosts such as github.com.',
        ],
      ],
    },
    {
      label: 'Restart the Claude app',
      intro: ['Quit the Claude app completely, not just its window. Open it again and start a new local Code session.'],
      notes: [
        [
          'TokenScope won’t appear under ',
          { strong: '+ → Plugins' },
          '. That’s expected: type ',
          { code: '/tokenscope:' },
          ' and its commands appear.',
        ],
      ],
      details: [
        [
          'The plugin installs when a session starts. The Plugins list shows marketplaces added in the app, not ones added in settings, so it doesn’t list this one.',
        ],
      ],
    },
    ...claudeAfterInstall('desktop'),
  ]
  return {
    ...head,
    lead: ['Do every step in a local Code session in the Claude app.'],
    prerequisites: CLAUDE_PREREQUISITES,
    steps: numbered(steps),
    troubleshooting: [
      [
        { strong: '“This host isn’t supported”:' },
        ' that is the app’s Add marketplace form, which takes only Git hosts. Paste the step 1 text into a Code session instead.',
      ],
      [
        { strong: 'No /tokenscope: commands after restarting:' },
        ' use a local Code session. Cloud sessions and WSL sessions don’t load plugins. Then check your settings file has both keys from step 1.',
      ],
      [
        { strong: '“Couldn’t start sign-in … a different server URL”:' },
        ' your app is using a copy of the plugin from before this was fixed (0.1.45 or earlier). Quit the Claude app completely, open it again and retry. If the message stays, ask your administrator.',
      ],
      [
        { strong: 'Status says this app isn’t linked to your computer:' },
        ' do what status says. If it says to log out and back in, or to restart your computer, setup is already done. Otherwise run ',
        { code: '/tokenscope:setup' },
        ' again in a Code session in the app, then quit the app completely and open it again (on Linux, log out and back in). Until then, this app’s usage arrives but can’t be linked to you.',
      ],
      [
        { strong: 'Added TokenScope from Git before?' },
        ' The app keeps one marketplace called tokenscope, so the old one can block this one. Ask your administrator to help remove it first.',
      ],
      windowsWithoutNode(),
      signInCantReturn('desktop'),
      statusNotGreen('desktop'),
      [
        { strong: 'Installing for a whole team?' },
        ' Ask your IT team. They may be able to push the same settings to every computer instead.',
      ],
    ],
  }
}

function claudeGuide(c: ConnectConfig): Guide {
  // A build with no server needs this step even when this deployment cannot
  // name its own origin: the user then gets the step without a URL to paste.
  const noServer = c.claudeBundledOrigin === ''
  const register = needsMcpRegistration(c, 'claude-code') && (noServer || Boolean(c.mcpUrl))
  // The deployment serves its own marketplace, with a plugin that already
  // points here: one URL, no Git, no server-URL step (self-served-marketplace.md).
  const served = c.claudeMarketplaceUrl
  const steps: StepBody[] = served
    ? [
        {
          label: 'Install the plugin',
          intro: ['Run these one at a time:'],
          commands: [`/plugin marketplace add ${served}`, `/plugin install ${SERVED_PLUGIN_REF}`],
          notes: [
            ['When asked, choose ', { strong: 'Install for you' }, '.'],
            ['If it asks for a server URL, keep the one it shows.'],
          ],
          details: [
            ['Run them separately: Claude Code treats a multi-line paste as one command.'],
            INSTALL_FOR_YOU_DETAIL,
            [
              'This deployment serves the plugin itself, already pointed at it. You don’t need Git or a GitHub account. Needs Claude Code 2.1.224 or later.',
            ],
          ],
        },
      ]
    : [
        {
          label: 'Install the plugin',
          intro: ['Run these one at a time:'],
          commands: [
            `/plugin marketplace add ${claudeMarketplaceArg(c)}`,
            `/plugin install ${c.claudePlugin}@${c.marketplaceName}`,
          ],
          notes: [['When asked, choose ', { strong: 'Install for you' }, '.']],
          details: [
            ['Run them separately: Claude Code treats a multi-line paste as one command.'],
            INSTALL_FOR_YOU_DETAIL,
          ],
        },
      ]
  if (register && !served) {
    const olderClient: Paragraph[] = c.mcpUrl
      ? [
          [
            'Older Claude Code? In a terminal, run: ',
            { code: `claude mcp add --transport http --scope user tokenscope ${c.mcpUrl}` },
          ],
        ]
      : []
    steps.push({
      label: 'Point the plugin at this deployment',
      intro: [
        'Run ',
        { code: '/plugin' },
        ', open ',
        { strong: 'tokenscope' },
        ' → ',
        { strong: 'Configure options' },
        ', and set ',
        { strong: 'TokenScope server URL' },
        c.origin ? ' to:' : '. Ask your administrator for the address.',
      ],
      ...(c.origin ? { commands: [c.origin] } : {}),
      notes: [['Needs Claude Code 2.1.207 or later.'], ...olderClient],
      details: [
        noServer
          ? ['This plugin build ships without a server, so you have to tell it which one to use.']
          : [
              'The plugin’s built-in server is ',
              { code: c.claudeBundledOrigin },
              ', not this deployment.',
            ],
        [
          'This is a user setting. A repository’s settings cannot change it, so a cloned project can never redirect your setup to another server.',
        ],
      ],
    })
  }
  steps.push(...claudeAfterInstall('cli'))
  return {
    testid: 'connect-claude-code',
    cmdTestidPrefix: 'install-cmd',
    icon: 'logos:claude-icon',
    name: 'Claude Code CLI',
    accent: '#D97757',
    lead: ['Do every step in Claude Code, in a terminal.'],
    prerequisites: CLAUDE_PREREQUISITES,
    steps: numbered(steps),
    troubleshooting: [
      [
        { strong: 'Using the Claude app?' },
        ' Use ',
        { strong: 'Connect Claude Desktop' },
        ' instead. The app handles ',
        { code: '/plugin' },
        ' commands differently.',
      ],
      ...(served
        ? [
            [
              { strong: '“Failed to add marketplace … source doesn’t match”:' },
              ' you added TokenScope from Git before. Run ',
              { code: '/plugin marketplace remove tokenscope' },
              ', then step 1 again. Removing it also removes the plugin and its saved settings.',
            ] as Paragraph,
            claudeGitFallback(c, register),
          ]
        : []),
      windowsWithoutNode(),
      signInCantReturn('cli'),
      ...(served
        ? []
        : [
            [
              { strong: '/mcp says “URL is unset or invalid”:' },
              ' run ',
              { code: '/plugin' },
              ', open tokenscope → Configure options, set the server URL, then restart Claude Code.',
            ] as Paragraph,
          ]),
      statusNotGreen('cli'),
    ],
  }
}

function copilotGuide(c: ConnectConfig): Guide {
  const register = needsMcpRegistration(c, 'copilot-cli') && c.mcpUrl
  const installDetails: Paragraph[] = [
    [
      'The first command adds ',
      { code: c.marketplaceSource },
      ' as a plugin marketplace. The second installs the ',
      { code: c.copilotPlugin },
      ' plugin from it.',
    ],
    [
      'Enterprise-managed organisations can ship the plugin through ',
      { code: '.github-private/.github/copilot/settings.json' },
      ' instead. It installs when you sign in to Copilot.',
    ],
  ]
  if (c.marketplaceRef) {
    installDetails.push([
      'This deployment pins Claude Code to ',
      { code: c.marketplaceRef },
      '. Copilot CLI has no documented way to pin a marketplace ref, so it installs from the default branch.',
    ])
  }
  const steps: StepBody[] = [
    {
      label: 'Install the plugin',
      badge: 'In a terminal',
      intro: ['Run these one at a time in your terminal, not inside Copilot:'],
      commands: [
        `copilot plugin marketplace add ${c.marketplaceSource}`,
        `copilot plugin install ${c.copilotPlugin}@${c.marketplaceName}`,
      ],
      details: installDetails,
    },
  ]
  if (register) {
    steps.push({
      label: 'Point the plugin at this deployment',
      badge: 'In a terminal',
      intro: ['Run:'],
      commands: [`copilot mcp add --transport http tokenscope ${c.mcpUrl}`],
      details: [
        [
          'The plugin’s built-in server is ',
          { code: c.copilotBundledOrigin },
          ', not this deployment.',
        ],
        [
          'Setup reads this registration ahead of the built-in one. Your organisation can avoid this step by publishing a plugin build that names this server.',
        ],
      ],
    })
  }
  steps.push(
    {
      label: 'Sign in and turn on tracking',
      badge: 'In Copilot',
      intro: [
        'Start ',
        { code: 'copilot' },
        ', type ',
        { code: '/' },
        ' and run the ',
        { strong: 'tokenscope-setup' },
        ' skill. Approve the sign-in in your browser, then follow its prompts.',
      ],
      details: [
        [
          'Setup signs you in, saves a credential on this computer (nothing to copy) and turns on the plugin’s usage extension, which sends each session’s usage to TokenScope.',
        ],
      ],
    },
    {
      label: 'Restart Copilot',
      badge: 'In a terminal',
      intro: ['Quit ', { code: 'copilot' }, ' and start it again.'],
      details: [
        [
          'The usage extension loads when a session starts, so the next session is the first one that sends usage.',
        ],
      ],
    },
    {
      label: 'Check it works',
      badge: 'In Copilot',
      intro: [
        'After a few minutes of using Copilot, type ',
        { code: '/' },
        ' and run the TokenScope ',
        { strong: 'status' },
        ' skill.',
      ],
      notes: [[{ strong: 'Green' }, ' means you’re done.']],
      details: [
        [
          'It checks that this computer can send usage, that a record arrived, and that it is tagged to a project. Usage takes about 5 minutes to arrive.',
        ],
        [
          'Copilot has no always-on status line, so run this whenever you want to check, or if your sessions seem to have stopped showing up.',
        ],
      ],
    },
  )
  return {
    testid: 'connect-copilot-cli',
    cmdTestidPrefix: 'copilot-install-cmd',
    icon: 'logos:github-copilot',
    name: 'Copilot CLI',
    accent: '#3e332d',
    lead: ['Some steps run in a terminal and some inside Copilot. Each step says where.'],
    steps: numbered(steps),
    troubleshooting: [
      [
        { strong: 'No browser, or it didn’t open:' },
        ' open the sign-in link Copilot prints, on any computer. Then open the link the sign-in page gives back on the computer running Copilot, in a browser or with ',
        { code: 'curl' },
        '.',
      ],
      [
        { strong: 'Status says your usage is untagged:' },
        ' run the ',
        { strong: 'project' },
        ' skill in that repo. Setup can’t fix tagging.',
      ],
      [
        { strong: 'Status says it isn’t sending:' },
        ' check you restarted ',
        { code: 'copilot' },
        ' and used it for a few minutes. Still not sending? Run the ',
        { strong: 'tokenscope-setup' },
        ' skill again.',
      ],
    ],
  }
}

export function buildGuide(kind: ConnectGuideKind, config: ConnectConfig): Guide {
  if (kind === 'claude-desktop') return desktopGuide(config)
  return kind === 'claude-cli' ? claudeGuide(config) : copilotGuide(config)
}
