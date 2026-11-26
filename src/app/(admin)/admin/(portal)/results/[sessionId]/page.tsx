import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import AnswerSymbol from "@/components/AnswerSymbol";
import Notice from "@/components/Notice";
import StatusPill from "@/components/StatusPill";
import { requireAdmin } from "@/lib/auth/session";
import { ANSWER_SLOTS } from "@/lib/design";
import { formatDateTime } from "@/lib/format";
import { avatarEmoji } from "@/lib/game/avatars";
import { computeQuestionStats } from "@/lib/game/results";
import { getSessionRepository } from "@/lib/game/sessions";
import { formatNumber } from "@/lib/quiz/number";
import { TYPE_LABELS } from "@/lib/quiz/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata: Metadata = { title: "Resultate" };

const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)} %`);
const seconds = (ms: number | null) => (ms === null ? "–" : `${formatNumber(Math.round(ms / 100) / 10)} s`);

export default async function ResultDetailPage({ params }: { params: Promise<{ sessionId: string }> }) {
  await requireAdmin();
  const { sessionId } = await params;
  if (!z.uuid().safeParse(sessionId).success) notFound();

  const detail = await getSessionRepository().getSessionDetail(sessionId);
  if (!detail) notFound();
  const { summary, players, questions, responses } = detail;
  const stats = computeQuestionStats(
    questions.map((question) => ({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      correctValue: question.correctValue,
      options: question.options.map((option) => ({ id: option.id, position: option.position, text: option.text, isCorrect: option.isCorrect })),
    })),
    responses,
    players.length,
  );
  const finished = summary.status === "finished";

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href="/admin/results" className="text-ink-soft text-sm font-semibold">
          ← Alle Resultate
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{summary.quizTitle}</h1>
          <StatusPill tone={finished ? "ok" : "neutral"}>{finished ? "Beendet" : summary.status === "cancelled" ? "Abgebrochen" : "Nicht abgeschlossen"}</StatusPill>
        </div>
        <p className="text-ink-soft text-sm">
          Spielcode {summary.joinCode}, {formatDateTime(summary.createdAt)}, {summary.playerCount} Teilnehmende
        </p>
      </header>

      {!finished ? <Notice tone="info">Diese Durchführung hat keine gespeicherten Resultate.</Notice> : null}

      {players.length > 0 ? (
        <section className="glass-card overflow-x-auto" aria-label="Rangliste">
          <h2 className="px-5 pt-5 text-lg font-semibold">Rangliste</h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-ink-soft border-b border-black/5 text-xs">
                <th className="px-5 py-3 font-semibold">Rang</th>
                <th className="px-5 py-3 font-semibold">Name</th>
                <th className="px-5 py-3 text-right font-semibold">Punkte</th>
                <th className="px-5 py-3 text-right font-semibold">Summe der Antwortzeiten</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <tr key={player.id} className="border-b border-black/5 last:border-0">
                  <td className="px-5 py-3 font-bold tabular-nums">{player.finalRank ?? "–"}</td>
                  <td className="px-5 py-3 font-semibold">
                    <span aria-hidden="true" className="mr-2">
                      {avatarEmoji(player.avatar)}
                    </span>
                    {player.name}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{formatNumber(player.totalPoints ?? 0)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{seconds(player.totalAnswerTimeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {finished ? (
        <section className="space-y-3" aria-label="Auswertung pro Frage">
          <h2 className="text-lg font-semibold">Auswertung pro Frage</h2>
          <ul className="space-y-3">
            {questions.map((question, index) => {
              const stat = stats[index];
              if (!stat) return null;
              return (
                <li key={question.id} className="glass-card space-y-3 p-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/5 text-sm font-bold">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold break-words">{question.prompt}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatusPill tone="neutral">{TYPE_LABELS[question.type]}</StatusPill>
                        <StatusPill tone="neutral">{stat.answered} von {players.length} geantwortet ({percent(stat.answeredShare)})</StatusPill>
                        {stat.correctShare !== null ? <StatusPill tone="ok">{percent(stat.correctShare)} richtig</StatusPill> : null}
                        <StatusPill tone="neutral">Ø Antwortzeit {seconds(stat.avgAnswerTimeMs)}</StatusPill>
                        {stat.avgPoints !== null ? <StatusPill tone="neutral">Ø Punkte {formatNumber(Math.round(stat.avgPoints))}</StatusPill> : null}
                      </div>
                    </div>
                  </div>

                  {question.type !== "estimate" ? (
                    <ul className="space-y-1.5">
                      {question.options.map((option, optionIndex) => {
                        const slot = ANSWER_SLOTS[optionIndex as 0 | 1 | 2 | 3];
                        const count = stat.distribution[optionIndex] ?? 0;
                        const share = stat.answered > 0 ? count / stat.answered : 0;
                        return (
                          <li key={option.id} className="flex items-center gap-3 text-sm">
                            <span className="flex w-5 justify-center" style={{ color: slot.background === "#ff9500" ? "#a35f00" : slot.background === "#34c759" ? "#18772f" : slot.background }}>
                              <AnswerSymbol shape={slot.shape} size={16} />
                            </span>
                            <span className="w-40 truncate sm:w-64">
                              {option.text}
                              {option.isCorrect ? <span className="sr-only"> (richtig)</span> : null}
                            </span>
                            <span className="h-2 flex-1 overflow-hidden rounded-full bg-black/10">
                              <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: slot.background }} />
                            </span>
                            <span className="w-16 text-right tabular-nums">
                              {count} {option.isCorrect ? "✓" : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : stat.estimate ? (
                    <p className="text-sm">
                      Richtig: <strong>{formatNumber(question.correctValue ?? 0)}{question.unit ? ` ${question.unit}` : ""}</strong>. Median der Schätzungen {formatNumber(stat.estimate.median)}, von {formatNumber(stat.estimate.min)} bis {formatNumber(stat.estimate.max)}, mittlere Abweichung {formatNumber(Math.round(stat.estimate.meanAbsoluteDeviation * 10) / 10)}.
                    </p>
                  ) : (
                    <p className="text-ink-soft text-sm">Es gab keine Schätzungen.</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
