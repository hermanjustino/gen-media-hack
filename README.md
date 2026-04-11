# Boostr + Momentum Engine

> "Boostr doesn't just detect trends — it tells creators exactly how to sustain momentum with a live action score."

A hackathon project built on the JellyJelly platform. Boostr ingests content from the JellyJelly API, runs it through an NLP pipeline, scores every topic cluster with a live Momentum Score, and outputs a prioritized action — not just a chart.

---

## What It Does

Most trend tools stop at "this is hot right now." Boostr goes further: it computes a Momentum Score for every topic cluster, predicts decay risk, matches the topic to creator opportunity, and tells you exactly what to do next.

The graph layer (Neo4j) connects Creators → Jellies → Phrases and tracks how topic clusters co-occur, which phrases are accelerating, and which are fading — in real time.

---

## Architecture

```
JellyJelly API
     │
     ▼
 topic_graph.ts        ← CLI pipeline (fetch → enrich → score → write)
     │
     ├── lib/jelly.ts       ← API client (search + full detail fetch)
     ├── lib/nlp.ts         ← tokenize, n-grams, TF-IDF, co-occurrence
     ├── lib/scorer.ts      ← MomentumScore + ActionPriority formulas
     └── lib/neo4j_graph.ts ← writes graph; Cypher queries
             │
             ▼
          Neo4j
      Creator ─POSTED─► Jelly ─MENTIONS─► Phrase
                                  │
                          CO_OCCURS_WITH
             │
             ▼
         server.ts         ← Express API  (:3000)
             │
             ▼
        public/index.html  ← D3.js force-directed graph UI
```

A separate Python script (`jellyjelly_firehose.py`) probes the JellyJelly Supabase backend for raw data discovery.

---

## Momentum Score Formula

```
MomentumScore = 0.35(Velocity)
              + 0.25(EngagementRate)
              + 0.20(ContributorGrowth)
              + 0.10(RecencyBoost)
              + 0.10(TopicSpread)
```

| Component | Definition |
|---|---|
| **Velocity** | views/hour (falls back to likes/hour if views unavailable) |
| **EngagementRate** | (likes + comments) / views |
| **ContributorGrowth** | new unique participants in the last 24h |
| **RecencyBoost** | exponential decay boost — fresh posts score higher |
| **TopicSpread** | count of related co-occurring keywords appearing in cluster |

---

## Momentum Action Formula

```
ActionPriority = MomentumScore × DecayRisk × OpportunityFit
```

| Factor | Definition |
|---|---|
| **DecayRisk** | High if velocity is dropping fast (recent avg < 70% of older avg) |
| **OpportunityFit** | High if topic matches the creator's historical content |

### Actions Output

| Action | Condition |
|---|---|
| **Double down now** | High score, low decay |
| **Collaborate injection** | High score, medium decay |
| **Remix / clip refresh** | Medium score, high decay |
| **Retire topic** | Low score, low opportunity fit |

---

## Graph Schema

**Nodes**

| Label | Key Properties |
|---|---|
| `Creator` | `id`, `username`, `full_name` |
| `Jelly` | `id`, `title`, `views`, `likes`, `comments`, `velocity`, `success`, `postedAt` |
| `Phrase` | `text`, `momentum`, `weightedScore`, `jellyCount`, `avgHoursOld` |

**Relationships**

| Relationship | Meaning |
|---|---|
| `(Creator)-[:POSTED]->(Jelly)` | creator owns content |
| `(Jelly)-[:MENTIONS {weight}]->(Phrase)` | content uses phrase |
| `(Phrase)-[:CO_OCCURS_WITH {weight}]->(Phrase)` | phrases appear together |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/graph?keyword=` | All phrase nodes + co-occurrence edges (D3 input) |
| `GET` | `/api/phrase/:phrase` | Stats, top jellies, neighbors, action recommendation |
| `GET` | `/api/stats` | Node counts + rising phrase count |
| `GET` | `/api/tavus/status` | Verify Tavus key and list available personas/replicas |
| `GET` | `/api/tavus/documents` | List Tavus Knowledge Base documents |
| `GET` | `/api/tavus/documents/:id` | Get a single Tavus KB document |
| `POST` | `/api/tavus/documents` | Create Tavus KB document from a public URL |
| `POST` | `/api/tavus/conversations` | Start a Tavus conversation using persona + docs |
| `POST` | `/api/tavus/brief/:phrase` | Build phrase trend brief markdown and optionally upload to Tavus KB |

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js + TypeScript (ESM) |
| API client | JellyJelly REST API v3 |
| NLP | Custom tokenizer, n-gram extractor, TF-IDF (no deps) |
| Graph DB | Neo4j (Aura cloud or local) |
| Server | Express 5 |
| Frontend | D3.js v7 force-directed graph |
| Data probe | Python 3 + requests (Supabase REST explorer) |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file:

```env
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
NEO4J_DATABASE=neo4j   # optional
TAVUS_KEY=your_tavus_api_key
# Optional but needed for one-click KB upload from generated briefs:
# must be publicly reachable by Tavus (for example, your deployed URL or ngrok URL)
TAVUS_PUBLIC_BASE_URL=https://your-public-url.example.com
```

### 3. Run the pipeline

```bash
# Fetch jellies for a keyword, score them, write to Neo4j
npm run topic-graph -- crypto --limit=100 --top=20 --clear
```

| Flag | Default | Description |
|---|---|---|
| `<keyword>` | `crypto` | Search term |
| `--limit=N` | `50` | Max jellies to fetch |
| `--top=N` | `20` | Top phrases to display |
| `--clear` | off | Wipe graph before writing |

### 4. Start the API server + UI

```bash
npm run server
# Open http://localhost:3000
```

---

## UI

The D3 visualization renders phrase clusters as a force-directed graph:

- **Node size** — weighted success score
- **Node color** — green (rising) / yellow (stable) / red (decaying)
- **Edge thickness** — co-occurrence frequency
- **Click a node** — opens the side panel with momentum badge, action recommendation, co-occurring phrases, and top jellies

---

## Tavus Integration

Generate a trend brief for a phrase:

```bash
curl -X POST "http://localhost:3000/api/tavus/brief/ai%20marketing" \
  -H "Content-Type: application/json" \
  -d '{"create_document": false}'
```

Generate brief and upload it to Tavus Knowledge Base:

```bash
curl -X POST "http://localhost:3000/api/tavus/brief/ai%20marketing" \
  -H "Content-Type: application/json" \
  -d '{"create_document": true, "base_url": "https://<public-host>"}'
```

Start a Tavus conversation grounded in those documents:

```bash
curl -X POST "http://localhost:3000/api/tavus/conversations" \
  -H "Content-Type: application/json" \
  -d '{
    "persona_id": "p123456789",
    "replica_id": "r123456789",
    "conversation_name": "Trend Coaching Session",
    "conversational_context": "Coach this creator on what to post next based on momentum trends.",
    "document_tags": ["boostr"]
  }'
```

---

## Pipeline Stages

```
[1/5] Fetch jellies via search API (paginated)
[2/5] Enrich each jelly with full engagement metrics (parallel batch)
[3/5] Score jellies (velocity, engagement rate, success)
[4/5] Build NLP corpus (tokenize → n-grams → TF-IDF → co-occurrence)
[5/5] Write graph to Neo4j → query + print top phrases with action recommendations
```

---

## Python Firehose

`jellyjelly_firehose.py` explores the JellyJelly Supabase backend using the platform's public anon key (intentionally public, sourced from client-side JS).

```bash
# Discovery mode — probe known table names
python3 jellyjelly_firehose.py

# Pull latest rows from a specific table
python3 jellyjelly_firehose.py jelly 20
```
