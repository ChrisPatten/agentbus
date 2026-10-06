import { defineConfig } from 'vitepress';

// The docs are published under /docs/ next to the hand-written landing page
// in site/ (see .github/workflows/pages.yml). Override with DOCS_BASE when the
// site is served from a sub-path, e.g. DOCS_BASE=/agentbus/docs/ for a GitHub
// project page without a custom domain.
const base = process.env.DOCS_BASE ?? '/docs/';
// The landing page lives one level above the docs.
const home = base.replace(/docs\/$/, '') || '/';

export default defineConfig({
  title: 'AgentBus',
  description: 'Connect your chat channels to Claude Code agents.',
  base,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: false,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }]],
  themeConfig: {
    logo: '/favicon.svg',
    // Not base-prefixed, so the logo returns to the landing page in site/.
    logoLink: { link: home, target: '_self' },
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Changelog', link: 'https://github.com/ChrisPatten/agentbus/blob/main/CHANGELOG.md' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is AgentBus?', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'How AgentBus works', link: '/concepts/how-it-works' },
          { text: 'Contacts and routing', link: '/concepts/contacts-and-routing' },
          { text: 'Conversations and sessions', link: '/concepts/conversations-and-sessions' },
        ],
      },
      {
        text: 'Channels',
        items: [
          { text: 'Telegram', link: '/channels/telegram' },
          { text: 'Email', link: '/channels/email' },
          { text: 'Mac app', link: '/channels/mac-app' },
          { text: 'Siri', link: '/channels/siri' },
          { text: 'Pebble', link: '/channels/pebble' },
        ],
      },
      {
        text: 'Agent runtimes',
        items: [
          { text: 'Choosing a runtime', link: '/runtimes/' },
          { text: 'cc-headless', link: '/runtimes/cc-headless' },
          { text: 'cc-pool', link: '/runtimes/cc-pool' },
          { text: 'claude-code', link: '/runtimes/claude-code' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Slash commands', link: '/features/slash-commands' },
          { text: 'Scheduling', link: '/features/scheduling' },
          { text: 'Attachments', link: '/features/attachments' },
          { text: 'Approvals', link: '/features/approvals' },
          { text: 'Threads and topics', link: '/features/threads-and-topics' },
          { text: 'Channel relay', link: '/features/channel-relay' },
          { text: 'Proactive messages', link: '/features/proactive-messages' },
          { text: 'Choosing models', link: '/features/models' },
          { text: 'Knowledge store', link: '/features/knowledge-store' },
          { text: 'Journaling and memory', link: '/features/journaling-and-memory' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'HTTP API', link: '/reference/http-api' },
          { text: 'MCP tools', link: '/reference/mcp-tools' },
          { text: 'Slash commands', link: '/features/slash-commands' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Running AgentBus', link: '/operations/deployment' },
          { text: 'Health and logs', link: '/operations/monitoring' },
          { text: 'Troubleshooting', link: '/operations/troubleshooting' },
          { text: 'Upgrading', link: '/operations/upgrading' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/ChrisPatten/agentbus' }],
    outline: { level: [2, 3] },
    footer: { message: 'Released under the MIT License.' },
  },
});
