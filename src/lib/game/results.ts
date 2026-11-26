/**
 * Kennzahlen pro Frage für die Resultatansicht. Reine Funktion über die gespeicherten Antworten.
 */
export type ResultQuestion = {
  id: string;
  type: "multiple_choice" | "estimate" | "poll";
  prompt: string;
  correctValue: number | null;
  options: { id: string; position: number; text: string; isCorrect: boolean }[];
};

export type ResultResponse = {
  questionId: string;
  optionId: string | null;
  numericValue: number | null;
  answerTimeMs: number;
  pointsAwarded: number;
};

export type QuestionStats = {
  questionId: string;
  answered: number;
  /** Anteil der Teilnehmenden, die geantwortet haben (0 bis 1). */
  answeredShare: number;
  /** Richtige Antworten bei Multiple Choice, sonst null. */
  correct: number | null;
  correctShare: number | null;
  avgAnswerTimeMs: number | null;
  avgPoints: number | null;
  /** Anzahl Antworten pro Option in der Reihenfolge der Optionen. */
  distribution: number[];
  /** Schätzfrage: Median, Minimum, Maximum der Schätzungen und mittlere absolute Abweichung. */
  estimate: { median: number; min: number; max: number; meanAbsoluteDeviation: number } | null;
};

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function computeQuestionStats(
  questions: readonly ResultQuestion[],
  responses: readonly ResultResponse[],
  playerCount: number,
): QuestionStats[] {
  return questions.map((question) => {
    const own = responses.filter((response) => response.questionId === question.id);
    const answered = own.length;
    const optionIds = [...question.options].sort((a, b) => a.position - b.position);
    const distribution = optionIds.map((option) => own.filter((response) => response.optionId === option.id).length);
    const correctIds = new Set(question.options.filter((option) => option.isCorrect).map((option) => option.id));
    const correct = question.type === "multiple_choice" ? own.filter((response) => response.optionId !== null && correctIds.has(response.optionId)).length : null;
    const values = own.flatMap((response) => (response.numericValue !== null ? [response.numericValue] : [])).sort((a, b) => a - b);
    const estimate =
      question.type === "estimate" && values.length > 0 && question.correctValue !== null
        ? {
            median: median(values),
            min: values[0] as number,
            max: values[values.length - 1] as number,
            meanAbsoluteDeviation: values.reduce((total, value) => total + Math.abs(value - (question.correctValue as number)), 0) / values.length,
          }
        : null;
    return {
      questionId: question.id,
      answered,
      answeredShare: playerCount > 0 ? answered / playerCount : 0,
      correct,
      correctShare: correct !== null && playerCount > 0 ? correct / playerCount : null,
      avgAnswerTimeMs: answered > 0 ? own.reduce((total, response) => total + response.answerTimeMs, 0) / answered : null,
      avgPoints: question.type === "poll" || playerCount === 0 ? null : own.reduce((total, response) => total + response.pointsAwarded, 0) / playerCount,
      distribution,
      estimate,
    };
  });
}
