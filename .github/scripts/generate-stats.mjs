// Generates self-hosted GitHub stat cards in the "Signal" theme.
// Replaces third-party services (github-readme-stats, streak-stats) whose
// shared public instances go down; these SVGs are committed to the repo so
// they always render.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const USER = "milanbeherazyx";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = fileURLToPath(new URL("../../assets/", import.meta.url));

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(1);
}

/* ── data ─────────────────────────────────────────────────────────── */

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const PROFILE_QUERY = `
  query ($login: String!) {
    user(login: $login) {
      name
      createdAt
      followers { totalCount }
      pullRequests { totalCount }
      issues { totalCount }
      repositoriesContributedTo(
        contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY]
        includeUserRepositories: false
      ) { totalCount }
      repositories(
        ownerAffiliations: OWNER
        isFork: false
        first: 100
        orderBy: { field: STARGAZERS, direction: DESC }
      ) {
        totalCount
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`;

const YEAR_QUERY = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;

async function collectData() {
  const { user } = await graphql(PROFILE_QUERY, { login: USER });

  const startYear = new Date(user.createdAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();

  let totalCommits = 0;
  let totalContributions = 0;
  const days = new Map();

  for (let year = startYear; year <= endYear; year++) {
    const data = await graphql(YEAR_QUERY, {
      login: USER,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    const c = data.user.contributionsCollection;
    totalCommits += c.totalCommitContributions;
    totalContributions += c.contributionCalendar.totalContributions;
    for (const week of c.contributionCalendar.weeks) {
      for (const d of week.contributionDays) {
        days.set(d.date, d.contributionCount);
      }
    }
  }

  const stars = user.repositories.nodes.reduce(
    (sum, r) => sum + r.stargazerCount,
    0
  );

  // Rank languages by how many repos use them, NOT by byte size. Byte size is
  // meaningless here: .ipynb files embed their cell outputs, so a handful of
  // notebooks reports as ~99% "Jupyter Notebook" and buries everything else.
  const langRepos = new Map();
  const langColor = new Map();
  for (const repo of user.repositories.nodes) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      langRepos.set(name, (langRepos.get(name) || 0) + 1);
      if (edge.node.color) langColor.set(name, edge.node.color);
    }
  }
  const totalMentions = [...langRepos.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...langRepos.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({
      name,
      repos: count,
      pct: (count / totalMentions) * 100,
      color: langColor.get(name) || "#6366f1",
    }));

  return {
    name: user.name || USER,
    createdAt: user.createdAt,
    followers: user.followers.totalCount,
    prs: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    repos: user.repositories.totalCount,
    stars,
    totalCommits,
    totalContributions,
    languages,
    ...computeStreaks(days),
  };
}

function computeStreaks(days) {
  const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const today = new Date().toISOString().slice(0, 10);

  let longest = 0;
  let longestStart = null;
  let longestEnd = null;
  let run = 0;
  let runStart = null;

  for (const [date, count] of sorted) {
    if (date > today) break;
    if (count > 0) {
      if (run === 0) runStart = date;
      run++;
      if (run > longest) {
        longest = run;
        longestStart = runStart;
        longestEnd = date;
      }
    } else {
      run = 0;
    }
  }

  // current streak: walk backwards from today (a zero today is still "alive")
  const upToToday = sorted.filter(([d]) => d <= today);
  let current = 0;
  let currentStart = null;
  let currentEnd = null;
  for (let i = upToToday.length - 1; i >= 0; i--) {
    const [date, count] = upToToday[i];
    if (count > 0) {
      if (current === 0) currentEnd = date;
      current++;
      currentStart = date;
    } else if (date === today) {
      continue; // today not done yet — doesn't break the streak
    } else {
      break;
    }
  }

  const firstActive = sorted.find(([, count]) => count > 0);
  const firstDate = firstActive ? firstActive[0] : today;
  return {
    currentStreak: current,
    currentStreakStart: currentStart,
    currentStreakEnd: currentEnd,
    longestStreak: longest,
    longestStreakStart: longestStart,
    longestStreakEnd: longestEnd,
    firstContribution: firstDate,
  };
}

/* ── rendering ────────────────────────────────────────────────────── */

const THEMES = {
  dark: {
    bg: "#0b0c10",
    panel: "rgba(255,255,255,0.028)",
    trackOpacity: 0.08,
    trackColor: "#ffffff",
    fg: "#ededf0",
    muted: "#9ba0ab",
    accent: "#22d3ee",
    grad: ["#6366f1", "#a855f7"],
    edge: ["#6366f1", "#a855f7", "#22d3ee"],
  },
  light: {
    bg: "#fafafa",
    panel: "rgba(16,17,22,0.022)",
    trackOpacity: 0.09,
    trackColor: "#101116",
    fg: "#101116",
    muted: "#4d5361",
    accent: "#0e7490",
    grad: ["#4f46e5", "#9333ea"],
    edge: ["#6366f1", "#a855f7", "#0e7490"],
  },
};

const SHORT_NAMES = {
  "Jupyter Notebook": "Jupyter",
  "Rich Text Format": "RTF",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fmt = (n) => n.toLocaleString("en-US");

const shortDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

function chrome(t, w, h) {
  return `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.grad[0]}"/><stop offset="1" stop-color="${t.grad[1]}"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.edge[0]}" stop-opacity=".7"/>
      <stop offset=".5" stop-color="${t.edge[1]}" stop-opacity=".2"/>
      <stop offset="1" stop-color="${t.edge[2]}" stop-opacity=".6"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.edge[2]}"/><stop offset="1" stop-color="${t.grad[1]}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <style>
    .mono { font-family: ui-monospace,'JetBrains Mono','SF Mono',Menlo,Consolas,monospace; font-variant-numeric: tabular-nums; }
    .fade { opacity:0; animation: fade .6s ease-out both; }
    .rise { opacity:0; animation: rise .6s cubic-bezier(.2,.7,.2,1) both; }
    .grow { transform-box: fill-box; transform-origin: left center; animation: grow .9s cubic-bezier(.2,.7,.2,1) both; }
    .ring { animation: ring 1.3s cubic-bezier(.2,.7,.2,1) both; }
    @keyframes fade { to { opacity:1 } }
    @keyframes rise { from { opacity:0; transform: translateY(9px) } to { opacity:1; transform: translateY(0) } }
    @keyframes grow { from { transform: scaleX(0) } }
    @keyframes ring { from { stroke-dashoffset: 233 } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; opacity: 1 !important } }
  </style>
  <rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
  <rect width="${w}" height="${h}" rx="14" fill="${t.panel}"/>
  <rect x=".75" y=".75" width="${w - 1.5}" height="${h - 1.5}" rx="13.25" fill="none" stroke="url(#edge)" stroke-width="1.5"/>`;
}

function statsCard(d, t) {
  const w = 450;
  const h = 185;
  const cells = [
    ["TOTAL COMMITS", fmt(d.totalCommits)],
    ["CONTRIBUTIONS", fmt(d.totalContributions)],
    ["PULL REQUESTS", fmt(d.prs)],
    ["ISSUES OPENED", fmt(d.issues)],
    ["PUBLIC REPOS", fmt(d.repos)],
    ["STARS EARNED", fmt(d.stars)],
  ];
  const cols = [24, 244];
  const rows = [86, 130, 174];

  const body = cells
    .map((c, i) => {
      const x = cols[i % 2];
      const y = rows[Math.floor(i / 2)];
      const delay = (0.3 + i * 0.07).toFixed(2);
      return `
    <text class="mono rise" x="${x}" y="${y - 15}" font-size="19" font-weight="700" fill="${t.fg}" style="animation-delay:${delay}s">${c[1]}</text>
    <text class="mono fade" x="${x}" y="${y}" font-size="9.5" letter-spacing="1.2" fill="${t.muted}" style="animation-delay:${delay}s">${c[0]}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="GitHub statistics for ${esc(USER)}">
  ${chrome(t, w, h)}
  <text class="mono fade" x="24" y="34" font-size="10.5" letter-spacing="1.6" fill="${t.accent}">GITHUB · @${esc(USER)}</text>
  <text class="mono fade" x="24" y="52" font-size="9.5" letter-spacing="1" fill="${t.muted}" style="animation-delay:.1s">SINCE ${shortDate(d.createdAt).toUpperCase()}</text>
  ${body}
  <rect class="grow" x="24" y="${h - 4}" width="140" height="2" rx="1" fill="url(#rule)" style="animation-delay:.8s"/>
</svg>
`;
}

function langsCard(d, t) {
  const w = 360;
  const h = 185;
  const barX = 24;
  const barW = w - 48;

  let offset = 0;
  const segments = d.languages
    .map((l, i) => {
      const segW = Math.max((l.pct / 100) * barW, 2);
      const x = barX + offset;
      offset += segW;
      const first = i === 0;
      const last = i === d.languages.length - 1;
      const r = first || last ? 5 : 0;
      return `<rect class="fade" x="${x.toFixed(1)}" y="62" width="${segW.toFixed(1)}" height="10" rx="${r}" fill="${l.color}" style="animation-delay:${(0.4 + i * 0.06).toFixed(2)}s"/>`;
    })
    .join("\n  ");

  const cols = [24, 196];
  const list = d.languages
    .map((l, i) => {
      const x = cols[i % 2];
      const y = 104 + Math.floor(i / 2) * 24;
      const delay = (0.5 + i * 0.06).toFixed(2);
      const short = SHORT_NAMES[l.name] || l.name;
      const label = short.length > 13 ? short.slice(0, 12) + "…" : short;
      return `
  <circle class="fade" cx="${x + 4}" cy="${y - 4}" r="4" fill="${l.color}" style="animation-delay:${delay}s"/>
  <text class="mono fade" x="${x + 16}" y="${y}" font-size="11" fill="${t.fg}" style="animation-delay:${delay}s">${esc(label)}</text>
  <text class="mono fade" x="${x + 148}" y="${y}" font-size="11" fill="${t.muted}" text-anchor="end" style="animation-delay:${delay}s">${l.pct.toFixed(1)}%</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Most used languages">
  ${chrome(t, w, h)}
  <text class="mono fade" x="24" y="34" font-size="10.5" letter-spacing="1.6" fill="${t.accent}">TOP LANGUAGES · BY REPO</text>
  <rect x="${barX}" y="62" width="${barW}" height="10" rx="5" fill="${t.trackColor}" fill-opacity="${t.trackOpacity}"/>
  <g class="grow" style="animation-delay:.35s;transform-origin:${barX}px 67px">
  ${segments}
  </g>
  ${list}
  <rect class="grow" x="24" y="${h - 4}" width="140" height="2" rx="1" fill="url(#rule)" style="animation-delay:.9s"/>
</svg>
`;
}

function streakCard(d, t) {
  const w = 820;
  const h = 190;
  const centers = [137, 410, 683];

  const col = (i, value, label, range, delay) => `
  <text class="mono rise" x="${centers[i]}" y="88" font-size="34" font-weight="700" fill="${t.fg}" text-anchor="middle" style="animation-delay:${delay}s">${value}</text>
  <text class="mono fade" x="${centers[i]}" y="124" font-size="10.5" letter-spacing="1.5" fill="${t.accent}" text-anchor="middle" style="animation-delay:${delay + 0.1}s">${label}</text>
  <text class="mono fade" x="${centers[i]}" y="146" font-size="9.5" fill="${t.muted}" text-anchor="middle" style="animation-delay:${delay + 0.15}s">${range}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Contribution streak: ${d.currentStreak} day current streak, ${d.longestStreak} day longest streak, ${fmt(d.totalContributions)} total contributions">
  ${chrome(t, w, h)}
  <text class="mono fade" x="24" y="34" font-size="10.5" letter-spacing="1.6" fill="${t.accent}">CONTRIBUTION STREAK</text>

  <line x1="273" y1="56" x2="273" y2="158" stroke="${t.trackColor}" stroke-opacity="${t.trackOpacity}" stroke-width="1"/>
  <line x1="546" y1="56" x2="546" y2="158" stroke="${t.trackColor}" stroke-opacity="${t.trackOpacity}" stroke-width="1"/>

  ${col(0, fmt(d.totalContributions), "TOTAL CONTRIBUTIONS", `${shortDate(d.firstContribution)} → now`, 0.3)}

  <circle class="fade" cx="${centers[1]}" cy="74" r="37" fill="none" stroke="${t.trackColor}" stroke-opacity="${t.trackOpacity}" stroke-width="4" style="animation-delay:.4s"/>
  <circle class="ring" cx="${centers[1]}" cy="74" r="37" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round"
          stroke-dasharray="233" stroke-dashoffset="0" transform="rotate(-90 ${centers[1]} 74)" style="animation-delay:.5s"/>
  ${col(1, fmt(d.currentStreak), "CURRENT STREAK", d.currentStreak ? `${shortDate(d.currentStreakStart)} → ${shortDate(d.currentStreakEnd)}` : "—", 0.45)}

  ${col(2, fmt(d.longestStreak), "LONGEST STREAK", d.longestStreak ? `${shortDate(d.longestStreakStart)} → ${shortDate(d.longestStreakEnd)}` : "—", 0.6)}

  <rect class="grow" x="24" y="${h - 4}" width="140" height="2" rx="1" fill="url(#rule)" style="animation-delay:1s"/>
</svg>
`;
}

/* ── main ─────────────────────────────────────────────────────────── */

const data = await collectData();
mkdirSync(OUT_DIR, { recursive: true });

for (const [themeName, theme] of Object.entries(THEMES)) {
  const suffix = themeName === "dark" ? "-dark" : "-light";
  writeFileSync(`${OUT_DIR}stats${suffix}.svg`, statsCard(data, theme));
  writeFileSync(`${OUT_DIR}langs${suffix}.svg`, langsCard(data, theme));
  writeFileSync(`${OUT_DIR}streak${suffix}.svg`, streakCard(data, theme));
}

console.log(
  `Generated stat cards — ${fmt(data.totalCommits)} commits, ` +
    `${fmt(data.totalContributions)} contributions, ` +
    `${data.currentStreak}d current / ${data.longestStreak}d longest streak, ` +
    `${data.languages.length} languages.`
);
