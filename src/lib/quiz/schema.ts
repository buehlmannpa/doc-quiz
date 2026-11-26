/**
 * Prüfung von Quiz und Fragen mit Zod. Dieselben Regeln gelten im Formular (sofortige Rückmeldung) und
 * auf dem Server (verbindlich). Die Datenbank erzwingt zusätzlich, was sich als CHECK Bedingung
 * ausdrücken lässt (siehe schema.ts der Datenbank).
 */
import { z } from "zod";

export const QUESTION_TYPES = ["multiple_choice", "estimate", "poll"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const LIMITS = {
  title: 120,
  description: 500,
  prompt: 300,
  optionText: 120,
  unit: 20,
  timeLimit: { min: 5, max: 120, default: 20 },
  maxPoints: { min: 1, max: 10_000, default: 1000 },
  options: { min: 2, max: 4 },
  /** Ein Live Quiz mit mehr Fragen ist unrealistisch. Die Grenze hält auch den Spielstand in Redis klein. */
  questionsPerQuiz: 50,
} as const;

export const quizMetaSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Bitte geben Sie einen Titel ein.")
    .max(LIMITS.title, `Der Titel darf höchstens ${LIMITS.title} Zeichen lang sein.`),
  description: z
    .string()
    .trim()
    .max(LIMITS.description, `Die Beschreibung darf höchstens ${LIMITS.description} Zeichen lang sein.`),
});
export type QuizMetaInput = z.infer<typeof quizMetaSchema>;

const optionSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Jede Antwort braucht einen Text.")
    .max(LIMITS.optionText, `Eine Antwort darf höchstens ${LIMITS.optionText} Zeichen lang sein.`),
  isCorrect: z.boolean(),
});

const promptSchema = z
  .string()
  .trim()
  .min(1, "Bitte geben Sie den Fragetext ein.")
  .max(LIMITS.prompt, `Der Fragetext darf höchstens ${LIMITS.prompt} Zeichen lang sein.`);

const timeLimitSchema = z
  .number({ error: "Bitte geben Sie das Zeitlimit als Zahl ein." })
  .int("Das Zeitlimit muss eine ganze Zahl sein.")
  .min(LIMITS.timeLimit.min, `Das Zeitlimit beträgt mindestens ${LIMITS.timeLimit.min} Sekunden.`)
  .max(LIMITS.timeLimit.max, `Das Zeitlimit beträgt höchstens ${LIMITS.timeLimit.max} Sekunden.`);

const maxPointsSchema = z
  .number({ error: "Bitte geben Sie die maximalen Punkte als Zahl ein." })
  .int("Die Punkte müssen eine ganze Zahl sein.")
  .min(LIMITS.maxPoints.min, `Die maximalen Punkte betragen mindestens ${LIMITS.maxPoints.min}.`)
  .max(LIMITS.maxPoints.max, `Die maximalen Punkte betragen höchstens ${LIMITS.maxPoints.max}.`);

const optionsSchema = z
  .array(optionSchema)
  .min(LIMITS.options.min, `Es braucht mindestens ${LIMITS.options.min} Antworten.`)
  .max(LIMITS.options.max, `Es sind höchstens ${LIMITS.options.max} Antworten möglich.`);

const multipleChoiceSchema = z
  .object({
    type: z.literal("multiple_choice"),
    prompt: promptSchema,
    timeLimitSeconds: timeLimitSchema,
    maxPoints: maxPointsSchema,
    options: optionsSchema,
  })
  .refine((question) => question.options.some((option) => option.isCorrect), {
    message: "Markieren Sie mindestens eine richtige Antwort.",
    path: ["options"],
  });

/** Umfrage: keine richtige Antwort und keine Punkte. Markierungen aus dem Formular werden ignoriert. */
const pollSchema = z
  .object({
    type: z.literal("poll"),
    prompt: promptSchema,
    timeLimitSeconds: timeLimitSchema,
    options: optionsSchema,
  })
  .transform((question) => ({
    ...question,
    maxPoints: 0,
    options: question.options.map((option) => ({ ...option, isCorrect: false })),
  }));

const estimateSchema = z.object({
  type: z.literal("estimate"),
  prompt: promptSchema,
  timeLimitSeconds: timeLimitSchema,
  maxPoints: maxPointsSchema,
  correctValue: z
    .number({ error: "Bitte geben Sie den richtigen Wert als Zahl ein." })
    .refine(Number.isFinite, "Der richtige Wert muss eine endliche Zahl sein."),
  unit: z.string().trim().max(LIMITS.unit, `Die Einheit darf höchstens ${LIMITS.unit} Zeichen lang sein.`),
  tolerance: z
    .number({ error: "Bitte geben Sie die Toleranz als Zahl ein." })
    .refine(Number.isFinite, "Die Toleranz muss eine endliche Zahl sein.")
    .refine((value) => value > 0, "Die Toleranz muss grösser als 0 sein."),
});

export const questionInputSchema = z.discriminatedUnion("type", [
  multipleChoiceSchema,
  estimateSchema,
  pollSchema,
]);

/** Eingabe vor der Prüfung. */
export type QuestionFormInput = z.input<typeof questionInputSchema>;
/** Geprüfte Frage, bereit zum Speichern. */
export type QuestionInput = z.output<typeof questionInputSchema>;

/** Wandelt die Fehler einer Prüfung in eine Liste lesbarer Meldungen, ohne Doppelte. */
export function issueMessages(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.message))];
}
