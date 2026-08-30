import { BskyAgent, RichText } from '@atproto/api';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Bluesky räknar grafem, inte kodpunkter: 📦 är ett tecken, inte två.
const MAX_POST = 300;
const graphemes = s =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;

// Posten är brödtexten plus länken. Rubrikraden som stod här förut upprepade
// paketnamnet som redan står i URL:en — 45 av 300 tecken för noll ny information,
// så versionen ligger i brödtexten i stället och länken får bära namnet.
const url      = `https://npmjs.com/package/${pkg.name}`;
const buildPost = text => `${text}\n\n${url}`;
// Vad brödtexten faktiskt får kosta. Räknas fram ur mallen i stället för att gissas:
// ett hårdkodat tak slutar stämma så fort paketnamnet eller mallen ändras, och den
// posten avvisas av API:et i stället för att kortas.
const BUDGET = MAX_POST - graphemes(buildPost(''));

async function writeRelease(limit) {
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

Inled med versionen, t.ex. "${pkg.version} — ".
Stil: torr, teknisk, rakt på sak. Ingen marketing-jargong, en emoji,
inga utropstecken, inga ordlekar med "smart". Max ${limit} tecken, hårt tak.
Skriv som en changelog-rad, inte som en tweet.
Svara med ren text, ingen markdown-formatering (inga kodblock,
ingen **fetstil**, inga #-headers).`,
      }],
    }),
  });
  if (!claudeRes.ok) {
    throw new Error(`Anthropic API svarade ${claudeRes.status}: ${await claudeRes.text()}`);
  }
  const { content } = await claudeRes.json();
  return content.find(b => b.type === 'text').text
    .trim()
    .replace(/^```[a-z]*\n?/i, '')   // ta bort ledande kodblock-fence
    .replace(/```$/, '')              // ta bort avslutande fence
    .trim();
}

// En handskriven notis går före den genererade. En modell som får en paket-
// beskrivning och ett versionsnummer kan säga vad som ändrats i ett patch-släpp,
// men inte väga femtio releaser mot varandra och avgöra vad läsaren behöver veta
// först. Sätt BSKY_TEXT för de släppen; lämna den tom för de vanliga.
let text = process.env.BSKY_TEXT?.trim();
if (text) {
  console.log('Använder BSKY_TEXT (handskriven notis), hoppar över genereringen');
} else {
  // Taket är en instruktion, inte en garanti, så posten mäts innan den skickas.
  // Ett försök till med ett stramare tak, sedan avbrott — hellre ingen annons än
  // en som API:et avvisar mitt i en release.
  text = await writeRelease(BUDGET);
  if (graphemes(buildPost(text)) > MAX_POST) {
    console.warn(`Texten blev ${graphemes(text)} tecken (tak ${BUDGET}), försöker igen`);
    text = await writeRelease(BUDGET - 20);
  }
}

const postText = buildPost(text);
const size     = graphemes(postText);
if (size > MAX_POST) {
  console.error(`Posten blev ${size} tecken, Bluesky tar max ${MAX_POST}. Inget postat:\n\n${postText}`);
  process.exit(1);
}

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
console.log(`Postat till Bluesky (${size}/${MAX_POST} tecken):`, uri);
