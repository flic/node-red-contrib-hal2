import { BskyAgent, RichText } from '@atproto/api';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Generera beskrivning
const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `Skriv en engelsk release-notis för npm-paketet "${pkg.name}" version ${pkg.version}.
Beskrivning: "${pkg.description ?? ''}"

Stil: torr, teknisk, rakt på sak. Ingen marketing-jargong, en emoji,
inga utropstecken, inga ordlekar med "smart". Max 200 tecken.
Skriv som en changelog-rad, inte som en tweet.
Svara med ren text, ingen markdown-formatering (inga kodblock,
ingen **fetstil**, inga #-headers).`,
    }],
  }),
});
const { content } = await claudeRes.json();
const text = content.find(b => b.type === 'text').text
  .trim()
  .replace(/^```[a-z]*\n?/i, '')   // ta bort ledande kodblock-fence
  .replace(/```$/, '')              // ta bort avslutande fence
  .trim();

// Bygg post-texten
const postText = `📦 ${pkg.name}@${pkg.version}\n\n${text}\n\nhttps://npmjs.com/package/${pkg.name}`;

// Posta till Bluesky
const agent = new BskyAgent({ service: process.env.BSKY_PDS_URL });
await agent.login({
  identifier: process.env.BSKY_HANDLE,
  password: process.env.BSKY_APP_PASSWORD, // app password, inte kontolösenordet
});

const rt = new RichText({ text: postText });
await rt.detectFacets(agent); // hittar URL:en och gör den klickbar

const { uri } = await agent.post({
  text: rt.text,
  facets: rt.facets,
  createdAt: new Date().toISOString(),
});
console.log('Postat till Bluesky:', uri);