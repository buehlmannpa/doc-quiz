"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import AnswerSymbol from "@/components/AnswerSymbol";
import Notice from "@/components/Notice";
import { ANSWER_SLOTS } from "@/lib/design";
import { parseDecimal } from "@/lib/quiz/number";
import { TYPE_LABELS } from "@/lib/quiz/rules";
import {
  issueMessages,
  LIMITS,
  QUESTION_TYPES,
  questionInputSchema,
  type QuestionFormInput,
  type QuestionType,
} from "@/lib/quiz/schema";
import { saveQuestionAction } from "../../actions";

export type QuestionFormInitial = {
  type: QuestionType;
  prompt: string;
  timeLimitSeconds: number;
  maxPoints: number;
  options: { text: string; isCorrect: boolean }[];
  correctValue: number | null;
  unit: string | null;
  tolerance: number | null;
};

type OptionState = { text: string; isCorrect: boolean };

const TYPE_HELP: Record<QuestionType, string> = {
  multiple_choice: "2 bis 4 Antworten, mindestens eine ist richtig. Punkte für richtig und schnell.",
  estimate: "Die Teilnehmenden schätzen eine Zahl. Je näher und schneller, desto mehr Punkte.",
  poll: "2 bis 4 Antworten ohne richtige Antwort. Es werden keine Punkte vergeben.",
};

const blankOptions = (): OptionState[] => Array.from({ length: 4 }, () => ({ text: "", isCorrect: false }));

export default function QuestionForm({
  quizId,
  questionId,
  initial,
}: {
  quizId: string;
  /** Null beim Anlegen einer neuen Frage. */
  questionId: string | null;
  initial: QuestionFormInitial | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);

  const [type, setType] = useState<QuestionType>(initial?.type ?? "multiple_choice");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [timeLimit, setTimeLimit] = useState(String(initial?.timeLimitSeconds ?? LIMITS.timeLimit.default));
  // Bei Umfragen ist 0 gespeichert. Für einen späteren Wechsel des Typs bleibt die Vorgabe erhalten.
  const [maxPoints, setMaxPoints] = useState(
    String(initial && initial.maxPoints > 0 ? initial.maxPoints : LIMITS.maxPoints.default),
  );
  const [options, setOptions] = useState<OptionState[]>(
    initial && initial.options.length > 0 ? initial.options.map((o) => ({ ...o })) : blankOptions(),
  );
  const [correctValue, setCorrectValue] = useState(initial?.correctValue != null ? String(initial.correctValue) : "");
  const [unit, setUnit] = useState(initial?.unit ?? "");
  const [tolerance, setTolerance] = useState(initial?.tolerance != null ? String(initial.tolerance) : "");

  function updateOption(index: number, patch: Partial<OptionState>) {
    setOptions((current) => current.map((option, i) => (i === index ? { ...option, ...patch } : option)));
  }

  /** Baut die Eingabe aus den Feldern. Ungültige Zahlen werden zu NaN und von der Prüfung gemeldet. */
  function buildInput(): QuestionFormInput {
    const base = { prompt, timeLimitSeconds: parseDecimal(timeLimit) ?? Number.NaN };
    const points = parseDecimal(maxPoints) ?? Number.NaN;
    // Leere Zeilen zählen nicht als Antwort. So muss niemand überzählige Felder entfernen.
    const filled = options.filter((option) => option.text.trim() !== "");
    if (type === "estimate") {
      return {
        type,
        ...base,
        maxPoints: points,
        correctValue: parseDecimal(correctValue) ?? Number.NaN,
        unit,
        tolerance: parseDecimal(tolerance) ?? Number.NaN,
      };
    }
    if (type === "poll") return { type, ...base, options: filled };
    return { type, ...base, maxPoints: points, options: filled };
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = buildInput();
    // Sofortige Rückmeldung ohne Netzwerk. Der Server prüft danach verbindlich noch einmal.
    const check = questionInputSchema.safeParse(input);
    if (!check.success) {
      setErrors(issueMessages(check.error));
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const result = await saveQuestionAction(quizId, questionId, input);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      router.push(`/admin/quizzes/${quizId}`);
      router.refresh();
    });
  }

  const showOptions = type !== "estimate";

  return (
    <form onSubmit={submit} className="space-y-8" noValidate>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Fragetyp</legend>
        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Fragetyp">
          {QUESTION_TYPES.map((candidate) => {
            const active = candidate === type;
            return (
              <button
                key={candidate}
                type="button"
                aria-pressed={active}
                onClick={() => setType(candidate)}
                className="rounded-2xl px-4 py-3 text-left text-sm font-semibold transition-colors"
                style={{
                  background: active ? "rgba(227, 6, 19, 0.08)" : "var(--field-bg)",
                  color: active ? "#a50410" : "var(--color-ink)",
                  boxShadow: active ? "inset 0 0 0 2px #e30613" : "none",
                }}
              >
                {TYPE_LABELS[candidate]}
              </button>
            );
          })}
        </div>
        <p className="text-ink-soft text-sm">{TYPE_HELP[type]}</p>
      </fieldset>

      <div>
        <label htmlFor="prompt" className="mb-1 block text-sm font-semibold">
          Fragetext
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          maxLength={LIMITS.prompt}
          rows={3}
          className="field min-h-24 py-3"
          placeholder="Zum Beispiel: Wie viele Ventile hat ein Desmosedici Motor?"
        />
        <p className="text-ink-soft mt-1 text-xs">
          {prompt.length} von {LIMITS.prompt} Zeichen. Der Text erscheint auf dem Bildschirm, auf den Smartphones nur die Antworten.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="timeLimit" className="mb-1 block text-sm font-semibold">
            Zeitlimit in Sekunden
          </label>
          <input
            id="timeLimit"
            inputMode="numeric"
            value={timeLimit}
            onChange={(event) => setTimeLimit(event.target.value)}
            className="field"
          />
          <p className="text-ink-soft mt-1 text-xs">
            {LIMITS.timeLimit.min} bis {LIMITS.timeLimit.max} Sekunden.
          </p>
        </div>
        {type === "poll" ? (
          <div className="flex items-end">
            <p className="text-ink-soft text-sm">Umfragen vergeben keine Punkte.</p>
          </div>
        ) : (
          <div>
            <label htmlFor="maxPoints" className="mb-1 block text-sm font-semibold">
              Maximale Punkte
            </label>
            <input
              id="maxPoints"
              inputMode="numeric"
              value={maxPoints}
              onChange={(event) => setMaxPoints(event.target.value)}
              className="field"
            />
            <p className="text-ink-soft mt-1 text-xs">
              Volle Punktzahl bei sehr schneller, richtiger Antwort. Mit der Zeit sinkt sie bis auf die Hälfte.
            </p>
          </div>
        )}
      </div>

      {showOptions ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Antworten</legend>
          <ul className="space-y-3">
            {options.map((option, index) => {
              const slot = ANSWER_SLOTS[index % 4] ?? ANSWER_SLOTS[0];
              return (
                <li key={index} className="flex items-center gap-3">
                  <span
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
                    style={{ background: slot.background, color: slot.foreground }}
                    title={slot.label}
                    aria-hidden="true"
                  >
                    <AnswerSymbol shape={slot.shape} size={22} />
                  </span>
                  <input
                    aria-label={`Antwort ${index + 1}`}
                    value={option.text}
                    onChange={(event) => updateOption(index, { text: event.target.value })}
                    maxLength={LIMITS.optionText}
                    className="field flex-1"
                    placeholder={`Antwort ${index + 1}`}
                  />
                  {type === "multiple_choice" ? (
                    <label className="flex shrink-0 items-center gap-2 text-sm font-semibold">
                      <input
                        type="checkbox"
                        checked={option.isCorrect}
                        onChange={(event) => updateOption(index, { isCorrect: event.target.checked })}
                        className="h-5 w-5"
                        style={{ accentColor: "#e30613" }}
                      />
                      richtig
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary !min-h-10 !px-3 text-sm"
                    aria-label={`Antwort ${index + 1} entfernen`}
                    disabled={options.length <= LIMITS.options.min}
                    onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={options.length >= LIMITS.options.max}
              onClick={() => setOptions((current) => [...current, { text: "", isCorrect: false }])}
            >
              Antwort hinzufügen
            </button>
            <p className="text-ink-soft text-xs">
              Leere Zeilen werden ignoriert. Es zählen {LIMITS.options.min} bis {LIMITS.options.max} Antworten.
              {type === "multiple_choice" ? " Mehrere richtige Antworten sind möglich, gewählt wird genau eine." : ""}
            </p>
          </div>
        </fieldset>
      ) : (
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold">Richtiger Wert</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="correctValue" className="mb-1 block text-sm font-semibold">
                Richtiger Wert
              </label>
              <input
                id="correctValue"
                inputMode="decimal"
                value={correctValue}
                onChange={(event) => setCorrectValue(event.target.value)}
                className="field"
                placeholder="216"
              />
            </div>
            <div>
              <label htmlFor="unit" className="mb-1 block text-sm font-semibold">
                Einheit (optional)
              </label>
              <input
                id="unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                maxLength={LIMITS.unit}
                className="field"
                placeholder="PS"
              />
            </div>
            <div>
              <label htmlFor="tolerance" className="mb-1 block text-sm font-semibold">
                Toleranz
              </label>
              <input
                id="tolerance"
                inputMode="decimal"
                value={tolerance}
                onChange={(event) => setTolerance(event.target.value)}
                className="field"
                placeholder="50"
              />
            </div>
          </div>
          <p className="text-ink-soft text-sm">
            Die Toleranz ist die Abweichung, ab der es 0 Punkte gibt. Beispiel: Richtiger Wert 216 und Toleranz 50. Wer genau
            216 schätzt, erhält die volle Genauigkeit, wer 241 schätzt die Hälfte, wer 266 oder mehr (oder 166 oder weniger)
            schätzt keine Punkte. Zahlen dürfen mit Punkt oder Komma geschrieben werden.
          </p>
        </fieldset>
      )}

      {errors.length > 0 ? (
        <Notice tone="error">
          <p className="mb-1 font-semibold">Bitte korrigieren Sie Folgendes:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Wird gespeichert …" : "Frage speichern"}
        </button>
        <Link href={`/admin/quizzes/${quizId}`} className="btn btn-secondary">
          Abbrechen
        </Link>
      </div>
    </form>
  );
}
