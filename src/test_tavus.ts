/**
 * Boostr — Tavus integration test
 *
 * Usage:
 *   npx tsx src/test_tavus.ts                    # discover + create conversation
 *   npx tsx src/test_tavus.ts --status-only       # just list personas & replicas
 *   npx tsx src/test_tavus.ts --persona=<id>      # skip discovery, use this persona
 *
 * What it does:
 *   1. Lists your Tavus personas and replicas (account health check)
 *   2. Creates a conversation where the AI acts as a JellyJelly social media coach
 *      with simulated trending data baked into the context
 *   3. Prints the conversation URL you can open in a browser
 */

import { readFileSync } from 'fs';
import { TavusClient } from './lib/tavus.js';

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadDotEnv() {
    try {
        const text = readFileSync('.env', 'utf8');
        for (const line of text.split('\n')) {
            const m = line.match(/^([A-Z0-9_]+)=([\s\S]*?)[\s]*$/);
            if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch { /* ignore */ }
}

loadDotEnv();

// ── Mock trending data (simulates what topic_graph + scorer would produce) ────
const MOCK_TRENDS = [
    {
        phrase: 'morning routine',
        momentum: 'rising',
        action: 'double_down',
        momentumScore: 0.82,
        decayRisk: 0.21,
        opportunityFit: 0.76,
        jellyCount: 14,
        avgHoursOld: 8,
        topJelly: { title: 'My 5am morning routine changed everything', creator: 'sarahlives', views: 48200 },
        coOccurring: ['productivity hacks', 'journaling', 'cold shower'],
    },
    {
        phrase: 'quiet luxury',
        momentum: 'stable',
        action: 'collaborate',
        momentumScore: 0.64,
        decayRisk: 0.52,
        opportunityFit: 0.61,
        jellyCount: 9,
        avgHoursOld: 22,
        topJelly: { title: 'Quiet luxury fit check — no logos needed', creator: 'minimalmike', views: 31500 },
        coOccurring: ['slow fashion', 'wardrobe basics', 'neutral tones'],
    },
    {
        phrase: 'ai tools',
        momentum: 'rising',
        action: 'double_down',
        momentumScore: 0.79,
        decayRisk: 0.18,
        opportunityFit: 0.83,
        jellyCount: 21,
        avgHoursOld: 5,
        topJelly: { title: 'These 3 AI tools saved me 10 hours this week', creator: 'techwithtara', views: 72000 },
        coOccurring: ['productivity', 'workflow automation', 'chatgpt'],
    },
    {
        phrase: 'raw travel',
        momentum: 'decaying',
        action: 'remix',
        momentumScore: 0.38,
        decayRisk: 0.74,
        opportunityFit: 0.42,
        jellyCount: 6,
        avgHoursOld: 41,
        topJelly: { title: 'Unfiltered 48 hours in Lisbon', creator: 'nomadnick', views: 19800 },
        coOccurring: ['solo travel', 'budget travel'],
    },
];

function buildCoachContext(trends: typeof MOCK_TRENDS): string {
    const lines: string[] = [
        'You are a JellyJelly social media coach powered by Boostr, a real-time trend engine.',
        'Below is the latest momentum data pulled from JellyJelly\'s trending content.',
        'Use this data to give the creator specific, actionable advice on what to post next.',
        '',
        '## LIVE TREND BRIEF (last 48h)',
        '',
    ];

    for (const t of trends) {
        const score  = (t.momentumScore * 100).toFixed(0);
        const decay  = (t.decayRisk * 100).toFixed(0);
        const ofit   = (t.opportunityFit * 100).toFixed(0);
        lines.push(`### "${t.phrase}"  [${t.momentum.toUpperCase()}]`);
        lines.push(`- Momentum Score: ${score}/100  |  Decay Risk: ${decay}%  |  Opportunity Fit: ${ofit}%`);
        lines.push(`- Supporting jellies: ${t.jellyCount}  |  Avg content age: ${t.avgHoursOld}h`);
        lines.push(`- Top performer: "${t.topJelly.title}" by @${t.topJelly.creator} (${t.topJelly.views.toLocaleString()} views)`);
        lines.push(`- Best pairings: ${t.coOccurring.map(c => `"${c}"`).join(', ')}`);
        lines.push(`- Recommended action: **${t.action.replace(/_/g, ' ').toUpperCase()}**`);
        lines.push('');
    }

    lines.push('## YOUR COACHING ROLE');
    lines.push('When the creator greets you, proactively share the top 2 trending opportunities');
    lines.push('and suggest 3 concrete video concepts they can post in the next 24 hours.');
    lines.push('Be specific: include hook ideas, talking points, and caption keywords.');

    return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const statusOnly = args.includes('--status-only');
    const personaArg = args.find(a => a.startsWith('--persona='))?.split('=')[1];

    const apiKey = process.env['TAVUS_KEY'];
    if (!apiKey) {
        console.error('\nMissing TAVUS_KEY in .env');
        process.exit(1);
    }

    const client = new TavusClient(apiKey);

    // ── Step 1: Account status ────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log('  Boostr × Tavus — Integration Test');
    console.log('═'.repeat(60));

    console.log('\n[1/3] Checking Tavus account status...');
    let personas: Awaited<ReturnType<typeof client.listPersonas>>['data'] = [];
    let replicas: Awaited<ReturnType<typeof client.listReplicas>>['data'] = [];

    try {
        const [pRes, rRes] = await Promise.all([
            client.listPersonas(),
            client.listReplicas(),
        ]);
        personas = pRes.data ?? [];
        replicas = rRes.data ?? [];
    } catch (err) {
        console.error('  Failed to reach Tavus API:', err instanceof Error ? err.message : err);
        process.exit(1);
    }

    console.log(`\n  Personas (${personas.length}):`);
    if (personas.length === 0) {
        console.log('    (none — create one at app.tavus.io)');
    } else {
        for (const p of personas) {
            const defaultReplica = p.default_replica_id ? ` — default replica: ${p.default_replica_id}` : '';
            console.log(`    • [${p.persona_id}]  ${p.persona_name}${defaultReplica}`);
        }
    }

    console.log(`\n  Replicas (${replicas.length}):`);
    if (replicas.length === 0) {
        console.log('    (none — create one at app.tavus.io)');
    } else {
        for (const r of replicas) {
            console.log(`    • [${r.replica_id}]  ${r.replica_name}  (${r.status}${r.replica_type ? ', ' + r.replica_type : ''})`);
        }
    }

    if (statusOnly) {
        console.log('\n  --status-only flag set. Skipping conversation creation.\n');
        return;
    }

    // ── Step 2: Pick persona ──────────────────────────────────────────────────
    console.log('\n[2/3] Preparing conversation...');

    const personaId = personaArg ?? personas[0]?.persona_id;
    if (!personaId) {
        console.error('\n  No persona found. Create one at app.tavus.io and re-run.');
        console.error('  Or pass --persona=<id> to specify one manually.');
        process.exit(1);
    }

    const chosenPersona = personas.find(p => p.persona_id === personaId);
    console.log(`  Using persona: ${chosenPersona?.persona_name ?? personaId} [${personaId}]`);

    // Use replica from persona default, or first available, or let Tavus decide
    const replicaId = chosenPersona?.default_replica_id ?? replicas[0]?.replica_id;
    if (replicaId) {
        const chosenReplica = replicas.find(r => r.replica_id === replicaId);
        console.log(`  Using replica: ${chosenReplica?.replica_name ?? replicaId} [${replicaId}]`);
    } else {
        console.log('  No replica found — Tavus will use persona default.');
    }

    const context = buildCoachContext(MOCK_TRENDS);

    console.log('\n  Trend context preview (first 400 chars):');
    console.log('  ' + context.slice(0, 400).replace(/\n/g, '\n  ') + '...');

    // ── Step 3: Create conversation ───────────────────────────────────────────
    console.log('\n[3/3] Creating Tavus conversation...');

    try {
        const conversation = await client.createConversation({
            persona_id: personaId,
            ...(replicaId ? { replica_id: replicaId } : {}),
            conversation_name: `Boostr Coach Session — ${new Date().toISOString().slice(0, 16)}`,
            conversational_context: context,
            custom_greeting: 'Hey! I\'ve just pulled the latest JellyJelly trend data. Want to know what\'s blowing up right now and exactly what you should post today?',
            test_mode: true,   // set to false when you want a real billable session
        });

        console.log('\n' + '═'.repeat(60));
        console.log('  Conversation created!');
        console.log('═'.repeat(60));
        console.log(`\n  ID:     ${conversation.conversation_id}`);
        console.log(`  Status: ${conversation.status}`);
        console.log(`\n  Open this URL in your browser to start chatting:`);
        console.log(`\n    ${conversation.conversation_url}\n`);

        if (conversation.meeting_token) {
            console.log(`  Meeting token: ${conversation.meeting_token}`);
        }

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('\n  Failed to create conversation:', msg);

        if (msg.includes('403') || msg.includes('401')) {
            console.error('  Check that TAVUS_KEY in .env is valid.');
        } else if (msg.includes('persona')) {
            console.error(`  Persona "${personaId}" may not exist — run with --status-only to verify.`);
        }
        process.exit(1);
    }
}

main().catch(err => {
    console.error('\nFatal:', err.message);
    process.exit(1);
});
