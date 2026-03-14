"use client";

import { useState, useEffect, useCallback } from "react";
import { getUsage, clearUsage, type UsageRecord } from "@/lib/api";
import { BarChart3, RefreshCw, Trash2, Zap, TrendingUp, Database, DollarSign } from "lucide-react";

function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toString();
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const AGENT_COLORS = ["#6c63ff", "#ff6b6b", "#43e97b", "#f7971e", "#a78bfa", "#38bdf8"];

interface AgentStat {
  name: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

export default function UsagePage() {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getUsage();
      setRecords(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const handleClear = async () => {
    if (!confirm("确认清空所有 token 用量记录？")) return;
    await clearUsage();
    setRecords([]);
  };

  // Aggregates
  const totalInput = records.reduce((s, r) => s + r.input_tokens, 0);
  const totalOutput = records.reduce((s, r) => s + r.output_tokens, 0);
  const totalCache = records.reduce((s, r) => s + r.cache_read_tokens, 0);
  const totalCost = records.reduce((s, r) => s + r.cost_usd, 0);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayCost = records.filter(r => r.timestamp >= today.getTime()).reduce((s, r) => s + r.cost_usd, 0);
  const cacheRatio = totalInput > 0 ? ((totalCache / (totalInput + totalCache)) * 100).toFixed(0) : "0";

  // Per-agent stats
  const byAgent = new Map<string, AgentStat>();
  for (const r of records) {
    const s = byAgent.get(r.agentId) ?? { name: r.agentName, calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    s.calls++;
    s.input += r.input_tokens;
    s.output += r.output_tokens;
    s.cacheRead += r.cache_read_tokens;
    s.cost += r.cost_usd;
    byAgent.set(r.agentId, s);
  }
  const agentEntries = Array.from(byAgent.entries());
  const maxTokens = agentEntries.reduce((m, [, s]) => Math.max(m, s.input + s.output), 0);

  const recent = [...records].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Token 用量</h1>
          <span className="text-xs text-muted-foreground font-mono ml-1">{records.length} 条记录</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded hover:border-primary/50 hover:text-primary transition-colors text-muted-foreground font-mono"
          >
            <RefreshCw className="h-3 w-3" />
            刷新
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-destructive/30 rounded hover:border-destructive hover:text-destructive transition-colors text-destructive/70 font-mono"
          >
            <Trash2 className="h-3 w-3" />
            清空
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { icon: Zap, label: "Input Tokens", value: fmt(totalInput), sub: `${records.length} 次调用`, color: "text-violet-400" },
          { icon: TrendingUp, label: "Output Tokens", value: fmt(totalOutput), sub: records.length ? `均值 ${fmt(Math.round(totalOutput / records.length))}` : "均值 —", color: "text-emerald-400" },
          { icon: Database, label: "缓存命中", value: fmt(totalCache), sub: `节省率 ${cacheRatio}%`, color: "text-rose-400" },
          { icon: DollarSign, label: "累计费用", value: `$${totalCost.toFixed(4)}`, sub: `今日 $${todayCost.toFixed(4)}`, color: "text-amber-400" },
        ].map(({ icon: Icon, label, value, sub, color }) => (
          <div key={label} className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Icon className={`h-3.5 w-3.5 ${color}`} />
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
            </div>
            <div className={`font-mono text-2xl font-bold ${color}`}>{loading ? "—" : value}</div>
            <div className="text-[11px] text-muted-foreground mt-1">{sub}</div>
          </div>
        ))}
      </div>

      {/* Agent Breakdown */}
      {agentEntries.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">按 Agent 分组</div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {agentEntries.map(([id, stat], i) => {
              const color = AGENT_COLORS[i % AGENT_COLORS.length];
              const total = stat.input + stat.output;
              const pct = maxTokens > 0 ? (total / maxTokens * 100) : 0;
              return (
                <div key={id} className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-semibold text-sm" style={{ color }}>{stat.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">@{id}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {[
                      { label: "Input", val: fmt(stat.input), c: color },
                      { label: "Output", val: fmt(stat.output), c: "var(--foreground)" },
                      { label: "缓存", val: fmt(stat.cacheRead), c: "#43e97b" },
                      { label: "费用", val: `$${stat.cost.toFixed(4)}`, c: "#f7971e" },
                    ].map(({ label, val, c }) => (
                      <div key={label} className="bg-muted/50 rounded p-2">
                        <div className="text-[9px] font-mono uppercase text-muted-foreground mb-1">{label}</div>
                        <div className="font-mono text-sm font-bold" style={{ color: c }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono mb-1">
                    <span>{stat.calls} 次调用</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1 bg-muted rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* History Table */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">调用历史（最近 100 条）</div>
        <div className="border border-border rounded-lg overflow-hidden">
          {recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BarChart3 className="h-8 w-8 mb-3 opacity-30" />
              <p className="text-sm font-mono">暂无记录，发送一条消息后刷新</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  {["时间", "Agent", "模型", "Harness", "Input", "Output", "缓存命中", "费用 $"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">{fmtTime(r.timestamp)}</td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{r.agentName}</span>
                      <span className="text-muted-foreground text-[10px] ml-1">@{r.agentId}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">{r.model || "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded border ${
                        r.harness === "codex" ? "bg-emerald-950/50 text-emerald-400 border-emerald-900/50" :
                        r.harness === "opencode" ? "bg-amber-950/50 text-amber-400 border-amber-900/50" :
                        "bg-violet-950/50 text-violet-400 border-violet-900/50"
                      }`}>{r.harness}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-violet-400">{fmt(r.input_tokens)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-emerald-400">{fmt(r.output_tokens)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-emerald-300">{fmt(r.cache_read_tokens)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-amber-400">
                      {r.cost_usd > 0 ? `$${r.cost_usd.toFixed(5)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
