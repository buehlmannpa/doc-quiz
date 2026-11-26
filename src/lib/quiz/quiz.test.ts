import { describe, expect, it } from "vitest";
import { formatNumber, parseDecimal } from "./number";
import {
  checkDeletable,
  checkEditable,
  checkTransition,
  isPlayable,
  moveInOrder,
  statusOptions,
  validateReadyToPlay,
  type StoredQuestion,
} from "./rules";
import { LIMITS, questionInputSchema, quizMetaSchema, issueMessages } from "./schema";

const options = (...entries: [string, boolean][]) => entries.map(([text, isCorrect]) => ({ text, isCorrect }));

describe("parseDecimal", () => {
  it("liest Schweizer und deutsche Schreibweisen", () => {
    expect(parseDecimal("42")).toBe(42);
    expect(parseDecimal("3.5")).toBe(3.5);
    expect(parseDecimal("3,5")).toBe(3.5);
    expect(parseDecimal("-2")).toBe(-2);
    expect(parseDecimal("1'250.5")).toBe(1250.5);
    expect(parseDecimal("1’250,5")).toBe(1250.5);
    expect(parseDecimal("1 250")).toBe(1250);
    expect(parseDecimal("  7  ")).toBe(7);
    expect(parseDecimal("0,25")).toBe(0.25);
  });

  it("lehnt ungültige Eingaben ab", () => {
    for (const bad of ["", "   ", "abc", "1,2,3", "1.2.3", "1e5", "--1", "1,", ",5", "5 km", "Infinity", "NaN", "0x10"]) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
  });
});

describe("formatNumber", () => {
  it("zeigt Zahlen in Schweizer Schreibweise", () => {
    expect(formatNumber(1250.5)).toMatch(/^1[’'’]250\.5$/);
    expect(formatNumber(42)).toBe("42");
  });
});

describe("quizMetaSchema", () => {
  it("verlangt einen Titel und kürzt Leerraum", () => {
    expect(quizMetaSchema.safeParse({ title: "  Ducati Quiz ", description: "" }).data?.title).toBe("Ducati Quiz");
    expect(quizMetaSchema.safeParse({ title: "   ", description: "" }).success).toBe(false);
    expect(quizMetaSchema.safeParse({ title: "x".repeat(LIMITS.title + 1), description: "" }).success).toBe(false);
    expect(quizMetaSchema.safeParse({ title: "ok", description: "y".repeat(LIMITS.description + 1) }).success).toBe(false);
  });
});

describe("questionInputSchema: Multiple Choice", () => {
  const valid = {
    type: "multiple_choice" as const,
    prompt: "Wie heisst das Wappentier?",
    timeLimitSeconds: 20,
    maxPoints: 1000,
    options: options(["Stier", true], ["Bär", false]),
  };

  it("akzeptiert eine gültige Frage", () => {
    expect(questionInputSchema.safeParse(valid).success).toBe(true);
  });

  it("erlaubt mehrere richtige Antworten", () => {
    const result = questionInputSchema.safeParse({ ...valid, options: options(["A", true], ["B", true], ["C", false]) });
    expect(result.success).toBe(true);
  });

  it("verlangt mindestens eine richtige Antwort", () => {
    const result = questionInputSchema.safeParse({ ...valid, options: options(["A", false], ["B", false]) });
    expect(result.success).toBe(false);
    if (!result.success) expect(issueMessages(result.error)).toContain("Markieren Sie mindestens eine richtige Antwort.");
  });

  it("verlangt 2 bis 4 Antworten", () => {
    expect(questionInputSchema.safeParse({ ...valid, options: options(["A", true]) }).success).toBe(false);
    const five = options(["A", true], ["B", false], ["C", false], ["D", false], ["E", false]);
    expect(questionInputSchema.safeParse({ ...valid, options: five }).success).toBe(false);
    const four = options(["A", true], ["B", false], ["C", false], ["D", false]);
    expect(questionInputSchema.safeParse({ ...valid, options: four }).success).toBe(true);
  });

  it("verlangt Text bei jeder Antwort und beim Fragetext", () => {
    expect(questionInputSchema.safeParse({ ...valid, options: options(["A", true], ["  ", false]) }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...valid, prompt: "  " }).success).toBe(false);
  });

  it("prüft Zeitlimit und Punkte auf Grenzen und ganze Zahlen", () => {
    for (const limit of [4, 121, 20.5, Number.NaN]) {
      expect(questionInputSchema.safeParse({ ...valid, timeLimitSeconds: limit }).success, `Zeitlimit ${limit}`).toBe(false);
    }
    for (const limit of [5, 120]) {
      expect(questionInputSchema.safeParse({ ...valid, timeLimitSeconds: limit }).success, `Zeitlimit ${limit}`).toBe(true);
    }
    for (const points of [0, -5, 10_001, 1.5]) {
      expect(questionInputSchema.safeParse({ ...valid, maxPoints: points }).success, `Punkte ${points}`).toBe(false);
    }
  });
});

describe("questionInputSchema: Schätzfrage", () => {
  const valid = {
    type: "estimate" as const,
    prompt: "Wie viele PS hat die Panigale V4?",
    timeLimitSeconds: 30,
    maxPoints: 1000,
    correctValue: 216,
    unit: "PS",
    tolerance: 50,
  };

  it("akzeptiert eine gültige Frage, auch ohne Einheit und mit negativem Wert", () => {
    expect(questionInputSchema.safeParse(valid).success).toBe(true);
    expect(questionInputSchema.safeParse({ ...valid, unit: "" }).success).toBe(true);
    expect(questionInputSchema.safeParse({ ...valid, correctValue: -12.5 }).success).toBe(true);
  });

  it("verlangt eine Toleranz grösser als 0", () => {
    expect(questionInputSchema.safeParse({ ...valid, tolerance: 0 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...valid, tolerance: -1 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...valid, tolerance: 0.001 }).success).toBe(true);
  });

  it("lehnt nicht endliche Zahlen und eine zu lange Einheit ab", () => {
    expect(questionInputSchema.safeParse({ ...valid, correctValue: Number.NaN }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...valid, correctValue: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...valid, tolerance: Number.NaN }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...valid, unit: "x".repeat(LIMITS.unit + 1) }).success).toBe(false);
  });
});

describe("questionInputSchema: Umfrage", () => {
  const valid = {
    type: "poll" as const,
    prompt: "Welche Farbe gefällt am besten?",
    timeLimitSeconds: 20,
    options: options(["Rot", false], ["Schwarz", false]),
  };

  it("vergibt keine Punkte und kennt keine richtige Antwort", () => {
    const result = questionInputSchema.safeParse({ ...valid, options: options(["Rot", true], ["Schwarz", true]) });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "poll") {
      expect(result.data.maxPoints).toBe(0);
      expect(result.data.options.every((option) => !option.isCorrect)).toBe(true);
    }
  });

  it("verlangt 2 bis 4 Antworten", () => {
    expect(questionInputSchema.safeParse({ ...valid, options: options(["Rot", false]) }).success).toBe(false);
  });
});

describe("questionInputSchema: Typ", () => {
  it("lehnt einen unbekannten Typ ab", () => {
    expect(questionInputSchema.safeParse({ type: "freitext", prompt: "x", timeLimitSeconds: 20 }).success).toBe(false);
  });
});

describe("Bearbeitungssperre und Löschen", () => {
  it("erlaubt Bearbeiten nur ohne Durchführung und vor dem Abschluss", () => {
    expect(checkEditable({ status: "draft", sessionCount: 0 }).allowed).toBe(true);
    expect(checkEditable({ status: "ready", sessionCount: 0 }).allowed).toBe(true);
    expect(checkEditable({ status: "ready", sessionCount: 1 }).allowed).toBe(false);
    expect(checkEditable({ status: "completed", sessionCount: 0 }).allowed).toBe(false);
  });

  it("nennt eine Begründung, die das Duplizieren erwähnt", () => {
    const check = checkEditable({ status: "ready", sessionCount: 2 });
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toMatch(/dupliz/i);
  });

  it("erlaubt Löschen nur ohne Durchführung", () => {
    expect(checkDeletable({ sessionCount: 0 }).allowed).toBe(true);
    expect(checkDeletable({ sessionCount: 3 }).allowed).toBe(false);
  });
});

describe("Statuswechsel", () => {
  const ctx = { sessionCount: 0, questionCount: 3 };

  it("erlaubt Entwurf zu Bereit mit Fragen, nicht ohne", () => {
    expect(checkTransition("draft", "ready", ctx).allowed).toBe(true);
    expect(checkTransition("draft", "ready", { sessionCount: 0, questionCount: 0 }).allowed).toBe(false);
  });

  it("erlaubt Bereit zurück in den Entwurf nur ohne Durchführung", () => {
    expect(checkTransition("ready", "draft", ctx).allowed).toBe(true);
    expect(checkTransition("ready", "draft", { ...ctx, sessionCount: 1 }).allowed).toBe(false);
  });

  it("erlaubt Abschliessen aus Entwurf und Bereit, danach nichts mehr", () => {
    expect(checkTransition("draft", "completed", ctx).allowed).toBe(true);
    expect(checkTransition("ready", "completed", { ...ctx, sessionCount: 4 }).allowed).toBe(true);
    for (const to of ["draft", "ready"] as const) expect(checkTransition("completed", to, ctx).allowed).toBe(false);
  });

  it("lehnt einen Wechsel auf den gleichen Status ab", () => {
    expect(checkTransition("draft", "draft", ctx).allowed).toBe(false);
  });

  it("zeigt für die Bedienelemente alle anderen Status, bei Abgeschlossen keine", () => {
    expect(statusOptions("draft", ctx).map((option) => option.to)).toEqual(["ready", "completed"]);
    expect(statusOptions("ready", ctx).map((option) => option.to)).toEqual(["draft", "completed"]);
    expect(statusOptions("completed", ctx)).toEqual([]);
  });

  it("nur Bereit ist spielbar", () => {
    expect(isPlayable("ready")).toBe(true);
    expect(isPlayable("draft")).toBe(false);
    expect(isPlayable("completed")).toBe(false);
  });
});

describe("moveInOrder", () => {
  it("vertauscht mit dem Nachbarn", () => {
    expect(moveInOrder(["a", "b", "c"], 1, "up")).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], 1, "down")).toEqual(["a", "c", "b"]);
  });

  it("gibt null am Rand und bei ungültigem Index, ohne die Eingabe zu verändern", () => {
    const list = ["a", "b", "c"];
    expect(moveInOrder(list, 0, "up")).toBeNull();
    expect(moveInOrder(list, 2, "down")).toBeNull();
    expect(moveInOrder(list, 5, "up")).toBeNull();
    expect(moveInOrder(list, -1, "down")).toBeNull();
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("validateReadyToPlay", () => {
  const mc: StoredQuestion = {
    type: "multiple_choice",
    prompt: "Frage",
    timeLimitSeconds: 20,
    maxPoints: 1000,
    correctValue: null,
    unit: null,
    tolerance: null,
    options: options(["A", true], ["B", false]),
  };

  it("verlangt mindestens eine Frage", () => {
    expect(validateReadyToPlay([])).toEqual(["Das Quiz hat keine Fragen."]);
  });

  it("akzeptiert gültige Fragen aller Typen", () => {
    const estimate: StoredQuestion = { ...mc, type: "estimate", options: [], correctValue: 5, unit: "km", tolerance: 2 };
    const poll: StoredQuestion = { ...mc, type: "poll", maxPoints: 0, options: options(["A", false], ["B", false]) };
    expect(validateReadyToPlay([mc, estimate, poll])).toEqual([]);
  });

  it("meldet Probleme mit der Nummer der Frage", () => {
    const broken: StoredQuestion = { ...mc, options: options(["A", false], ["B", false]) };
    const problems = validateReadyToPlay([mc, broken]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Frage 2: /);
  });
});
