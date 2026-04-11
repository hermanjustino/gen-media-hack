/**
 * Boostr — main pipeline
 *
 * Usage:
 *   npx tsx src/topic_graph.ts <keyword> [--limit=50] [--top=20] [--clear]
 *
 * Env vars required (in .env):
 *   NEO4J_URI       e.g. neo4j+s://xxxxxxxx.databases.neo4j.io
 *   NEO4J_USERNAME  neo4j
 *   NEO4J_PASSWORD  <your password>
 */

import { JellyClient, type Jelly } from './lib/jelly.js';
import { tokenize, extractNgrams, computeCorpusTfIdf, buildCoOccurrence } from './lib/nlp.js';
import { scoreJelly, scorePhrases, ACTION_LABEL, type JellyScore } from './lib/scorer.js';
import {
    createDriver, clearGraph, writeGraph,
    queryTopPhrases, queryNeighbors,
} from './lib/neo4j_graph.js';

// ── Load env ──────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';

function env(key: string, fallback?: string): string {
    const val = process.env[key] ?? fallback;
    if (!val) throw new Error(`Missing env var: ${key}`);
    return val;
}

function loadDotEnv() {
    try {
        const text = readFileSync('.env', 'utf8');
        for (const line of text.split('\n')) {
            const m = line.match(/^([A-Z0-9_]+)=([\s\S]*?)[\s]*$/);
            if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch { /* no .env file */ }
}

// ── Fetch jellies (paginated) ─────────────────────────────────────────────────
async function fetchBatch(
    keyword: string,
    limit: number,
    sortBy: 'views' | 'date' | 'likes',
    label: string,
): Promise<Jelly[]> {
    const client = new JellyClient();
    const pageSize = Math.min(limit, 50);
    const pages = Math.ceil(limit / pageSize);
    const results: Jelly[] = [];

    for (let page = 1; page <= pages; page++) {
        process.stdout.write(`  [${label}] page ${page}/${pages}...`);
        const res = await client.search({ q: keyword, page_size: pageSize, page, sort_by: sortBy, ascending: false });
        results.push(...res.jellies);
        console.log(` ${res.jellies.length} (total: ${res.total})`);
        if (results.length >= res.total) break;
    }
    return results.slice(0, limit);
}

async function fetchJellies(keyword: string, limit: number): Promise<Jelly[]> {
    // Split the budget: 60% newest-first (fresh content for rising detection),
    // 40% most-viewed (established baseline for velocity comparison).
    // Without recent jellies in the corpus, recentVelocity is always 0 and
    // everything reads as decaying.
    const recentLimit = Math.ceil(limit * 0.6);
    const popularLimit = Math.floor(limit * 0.4);

    const [recent, popular] = await Promise.all([
        fetchBatch(keyword, recentLimit, 'date', 'newest'),
        fetchBatch(keyword, popularLimit, 'likes', 'popular'),
    ]);

    // Deduplicate by id — recent wins on conflict
    const seen = new Set<string>();
    const merged: Jelly[] = [];
    for (const j of [...recent, ...popular]) {
        if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
        }
    }
    return merged;
}

// ── Fetch jelly details in parallel batches ───────────────────────────────────
async function enrichJellies(jellies: Jelly[], batchSize = 10): Promise<Jelly[]> {
    const client = new JellyClient();
    const enriched: Jelly[] = [];

    for (let i = 0; i < jellies.length; i += batchSize) {
        const batch = jellies.slice(i, i + batchSize);
        process.stdout.write(`  Enriching jellies ${i + 1}–${i + batch.length}/${jellies.length}...`);
        const details = await Promise.all(
            batch.map(j => client.getById(j.id).catch(() => j)) // fall back to search data
        );
        enriched.push(...details);
        console.log(' done');
    }
    return enriched;
}

// ── Build NLP corpus ──────────────────────────────────────────────────────────
function buildCorpus(jellies: Jelly[]) {
    // Each document = tokens from title + summary
    const documents: string[][] = jellies.map(j => {
        const text = [j.title, j.summary ?? ''].join(' ');
        const tokens = tokenize(text);
        return extractNgrams(tokens, [1, 2, 3]);
    });

    const tfidfMap = computeCorpusTfIdf(documents);

    // phrase -> list of jellyIds
    const phraseToJellies = new Map<string, string[]>();
    // jellyId -> list of phrases
    const jellyToPhrases = new Map<string, string[]>();

    for (let i = 0; i < jellies.length; i++) {
        const jellyId = jellies[i].id;
        jellyToPhrases.set(jellyId, documents[i]);
        for (const phrase of documents[i]) {
            const list = phraseToJellies.get(phrase) ?? [];
            list.push(jellyId);
            phraseToJellies.set(phrase, list);
        }
    }

    return { documents, tfidfMap, phraseToJellies, jellyToPhrases };
}

// ── Pretty print ──────────────────────────────────────────────────────────────
function bar(score: number, max: number, width = 20): string {
    const filled = Math.round((score / max) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function momentumIcon(m: string) {
    if (m === 'rising') return '↑';
    if (m === 'decaying') return '↓';
    return '→';
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // Parse args
    const args = process.argv.slice(2);
    const keyword = args.find(a => !a.startsWith('--')) ?? 'crypto';
    const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '50');
    const topN = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] ?? '20');
    const doClear = args.includes('--clear');

    // Load .env
    loadDotEnv();

    const NEO4J_URI = env('NEO4J_URI');
    const NEO4J_USER = env('NEO4J_USERNAME');
    const NEO4J_PASS = env('NEO4J_PASSWORD');
    const NEO4J_DB = process.env['NEO4J_DATABASE'];

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Boostr  —  keyword: "${keyword}"`);
    console.log(`${'═'.repeat(60)}\n`);

    // 1. Fetch
    console.log(`[1/5] Fetching up to ${limit} jellies...`);
    const rawJellies = await fetchJellies(keyword, limit);
    console.log(`      → ${rawJellies.length} jellies fetched\n`);

    // 2. Enrich with engagement data
    console.log('[2/5] Enriching with engagement metrics...');
    const jellies = await enrichJellies(rawJellies);
    console.log();

    // 3. Score jellies
    console.log('[3/5] Scoring jellies...');
    const jellyScores = new Map<string, JellyScore>();
    for (const j of jellies) {
        jellyScores.set(j.id, scoreJelly(j));
    }
    console.log(`      → scored ${jellyScores.size} jellies\n`);

    // 4. NLP corpus
    console.log('[4/5] Building NLP corpus...');
    const { documents, tfidfMap, phraseToJellies, jellyToPhrases } = buildCorpus(jellies);

    // Build TF-IDF weight map for scorer
    const tfIdfWeight = new Map<string, number>();
    for (const [phrase, info] of tfidfMap) {
        tfIdfWeight.set(phrase, info.avgTfIdf);
    }

    // Filter to phrases appearing in ≥2 jellies for co-occurrence
    const topPhraseSet = new Set(
        [...phraseToJellies.entries()]
            .filter(([, ids]) => ids.length >= 2)
            .map(([p]) => p)
    );

    const coOccurrence = buildCoOccurrence(documents, topPhraseSet);

    // Score phrases (pass coOccurrence so TopicSpread is computed inside scorer)
    const phraseScores = scorePhrases(phraseToJellies, jellyScores, tfIdfWeight, coOccurrence)
        .filter(ps => ps.jellyCount >= 2)
        .slice(0, 200); // cap for Neo4j write

    console.log(`      → ${phraseScores.length} scored phrases, ${coOccurrence.size} co-occurrence edges\n`);

    // 5. Write to Neo4j
    console.log('[5/5] Writing graph to Neo4j...');
    console.log(`      URI:  ${NEO4J_URI}`);
    console.log(`      User: ${NEO4J_USER}`);
    const driver = createDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASS);
    const session = driver.session({ database: NEO4J_DB });

    // Verify connectivity before writing
    try {
        await driver.verifyConnectivity();
        console.log('      Connected to Neo4j ✓\n');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n  Connection failed: ${msg}`);
        console.error('  Check NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD in .env');
        await driver.close();
        process.exit(1);
    }

    try {
        if (doClear) {
            console.log('  Clearing existing graph...');
            await clearGraph(session);
        }

        await writeGraph(
            session,
            jellies,
            jellyScores,
            phraseScores,
            phraseToJellies,
            jellyToPhrases,
            coOccurrence,
        );
    } finally {
        // ── Results ────────────────────────────────────────────────────────────
        console.log(`\n${'═'.repeat(60)}`);
        console.log('  TOP PHRASES BY MOMENTUM');
        console.log(`${'═'.repeat(60)}`);

        const top = await queryTopPhrases(session, topN);
        const maxScore = top[0]?.score ?? 1;

        console.log(`\n${'Phrase'.padEnd(35)} Momentum  Score  Jellies  Avg Age  Action`);
        console.log('─'.repeat(95));
        for (const p of top) {
            const icon = momentumIcon(p.momentum);
            const scoreBar = bar(p.score, maxScore, 12);
            const action = ACTION_LABEL[p.action as keyof typeof ACTION_LABEL] ?? p.action;
            console.log(
                `${p.phrase.padEnd(35)} ${icon} ${p.momentum.padEnd(8)}  ${scoreBar}  ${String(p.jellyCount).padStart(3)}  ${p.avgHoursOld.toFixed(0).padStart(4)}h  ${action}`
            );
        }

        // Rising phrases
        const rising = top.filter(p => p.momentum === 'rising');
        if (rising.length > 0) {
            console.log(`\n${'═'.repeat(60)}`);
            console.log('  RISING MOMENTUM CLUSTER');
            console.log(`${'═'.repeat(60)}`);

            const topRising = rising[0];
            const neighbors = await queryNeighbors(session, topRising.phrase, 5);
            console.log(`\n  Top phrase: "${topRising.phrase}"`);
            console.log('  Strongest co-occurring phrases:');
            for (const n of neighbors) {
                console.log(`    ${momentumIcon(n.momentum)} "${n.phrase}"  (co-occurs ${n.coWeight}x, ${n.momentum})`);
            }

            // Actionable recommendation
            const combo = neighbors
                .filter(n => n.momentum === 'rising' || n.momentum === 'stable')
                .slice(0, 2)
                .map(n => `"${n.phrase}"`)
                .join(' + ');

            console.log(`\n  ★ RECOMMENDATION:`);
            console.log(`    Post with ${combo ? `${combo} + ` : ''}"${topRising.phrase}" in the next 6 hours.`);
            console.log(`    This cluster is currently ${topRising.momentum} and avg jelly age is ${topRising.avgHoursOld.toFixed(0)}h.`);
        }

        // Decay warning
        const decaying = top.filter(p => p.momentum === 'decaying');
        if (decaying.length > 0) {
            console.log(`\n  ⚠ DECAY WARNING: "${decaying[0].phrase}" is losing momentum — avoid overusing this angle.`);
        }

        await session.close();
        await driver.close();
    }

    console.log(`\n${'═'.repeat(60)}\n`);
}

main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
