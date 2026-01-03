# 🎯 MCP Benchmark System Guide

This directory contains the integrated benchmark engine designed to precisely measure the performance, accuracy, and efficiency of `Smart-Context-MCP`.

## 🚀 How to Run

```bash
npm exec tsx benchmarks/main.ts
```
If `npm exec` is blocked by sandbox/permissions, run:
```bash
node --import tsx benchmarks/main.ts
```
*Results are automatically generated as Markdown files in the `benchmarks/reports/` directory.*

## 🎛️ Scenarios (P2)

You can run a fixed scenario (stable include/exclude + query set) for more reproducible results:

```bash
# P2 Scale Profiles (ADR-042-003)
node --import tsx benchmarks/main.ts --scenario p2-s   # Small (≤50k embeddings, ≤10k files)
node --import tsx benchmarks/main.ts --scenario p2-m   # Medium (50k-250k embeddings, 10k-50k files)
node --import tsx benchmarks/main.ts --scenario p2-l   # Large (250k-1M embeddings, 50k+ files)
```

Scenario files live in `benchmarks/scenarios/` and define include/exclude globs and expected recall targets.

### P2 Metrics (ADR-042-003)

Each scenario collects comprehensive P2 metrics:

**Latency**: Search p50/p95/p99, Vector query p50/p95/p99, Vector index build time

**Memory**: RSS, Heap Used, Heap Total

**Storage**: Embeddings Pack size, Vector Index size, Trigram Index size

**Quality**: Recall@1, Recall@10

Reports are automatically saved to `benchmarks/reports/full-report-<timestamp>.md` with detailed P2 metric breakdown.

---

## 📊 8-Step Diagnostic Metrics

| Step | Metric | Description | Target Threshold |
| :--- | :--- | :--- | :--- |
| **1** | **Cold Start Speed** | Time to scan and index 500 files from scratch (Parallel efficiency). | **< 500ms** (< 1ms per file) |
| **2** | **Incremental Scan** | Latency to detect and process a newly added file after initial indexing. | **< 50ms** |
| **3** | **Skeleton Gen Speed** | Speed of parsing a large file (500+ lines) via AST to extract its structure. | **< 30ms** |
| **4** | **Compression Ratio** | String compression rate of the Skeleton view vs. Original code (Token ROI). | **> 85%** (Higher is better) |
| **5** | **Intent Accuracy** | Success rate of classifying user query intent (e.g., 'symbol', 'file', 'bug'). | **100%** |
| **6** | **Search Recall@1** | Accuracy of ranking the most relevant file at the #1 position in hybrid search. | **> 90%** |
| **7** | **Dep Graph Latency** | Time taken to traverse the graph for dependency and impact analysis. | **< 10ms** |
| **8** | **Profiling Speed** | Latency of analyzing file metadata (indentation, encoding, config type). | **< 5ms** |

---

## 🔍 Interpretation Guide

### 1. Status Icon Meanings
*   🚀 (**Performance**): Processing speed indicators. Lower latency leads to a more responsive Agent experience.
*   ✅ (**Accuracy/Efficiency**): Indicators for logical precision or token economy. Higher values improve cost-effectiveness.

### 2. Troubleshooting Poor Metrics
*   **Slow Step 1 or 2**: Verify if any blocking synchronous code was introduced into the I/O parallelization logic (e.g., `Promise.all`).
*   **Low Step 4 Savings**: Check if `SkeletonGenerator` folding rules have become too conservative or if the AST parsing is failing.
*   **Low Step 6 Accuracy**: Review the weight balance in `AdaptiveWeights` to ensure it isn't overly biased toward a single signal.

---

## 🛠️ Engine Architecture
- `main.ts`: The single entry point that controls all benchmark suites and generates reports.
- `reports/`: Historical performance data stored with execution timestamps.

**Note**: These benchmarks directly reference the live source code in `src/`. Any modifications to the core logic will be reflected in the results immediately.
