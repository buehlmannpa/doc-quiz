/**
 * Legt ein Demo Quiz mit sechs Fragen an (alle Fragetypen), bereit zum Spielen.
 *
 * Verwendung: npm run seed:demo
 * Es verwendet DATABASE_URL aus .env.local oder der Umgebung. Das Quiz erscheint danach unter Quizzes mit dem
 * Status Bereit. Wer es mehrfach ausführt, erhält mehrere Quizzes mit demselben Titel. Zum Aufräumen genügt es,
 * sie im Adminportal zu löschen (solange sie keine Durchführung haben).
 */
import { config } from "dotenv";
import { createQuizRepository } from "@/lib/quiz/repository";
import { getDb, getPool } from "@/lib/db/client";
import type { QuestionInput } from "@/lib/quiz/schema";

config({ path: [".env.local", ".env"], quiet: true });

const choice = (text: string[], correct: number[]) => text.map((label, index) => ({ text: label, isCorrect: correct.includes(index) }));

const QUESTIONS: QuestionInput[] = [
  {
    type: "multiple_choice",
    prompt: "In welcher Stadt hat Ducati ihren Hauptsitz?",
    timeLimitSeconds: 20,
    maxPoints: 1000,
    options: choice(["Mailand", "Bologna", "Turin", "Rom"], [1]),
  },
  {
    type: "estimate",
    prompt: "In welchem Jahr wurde Ducati gegründet?",
    timeLimitSeconds: 30,
    maxPoints: 1000,
    correctValue: 1926,
    unit: "",
    tolerance: 20,
  },
  {
    type: "poll",
    prompt: "Welcher Pass ist Ihre Lieblingstour?",
    timeLimitSeconds: 20,
    maxPoints: 0,
    options: choice(["Furka", "Grimsel", "Susten", "Nufenen"], []),
  },
  {
    type: "multiple_choice",
    prompt: "Welche dieser Modelle stammen von Ducati? (mehrere Antworten sind richtig, wählen Sie eine)",
    timeLimitSeconds: 20,
    maxPoints: 1000,
    options: choice(["Monster", "Multistrada", "Ninja", "Fireblade"], [0, 1]),
  },
  {
    type: "estimate",
    prompt: "Wie viele Zylinder hat der Motor der Panigale V4?",
    timeLimitSeconds: 20,
    maxPoints: 800,
    correctValue: 4,
    unit: "Zylinder",
    tolerance: 4,
  },
  {
    type: "multiple_choice",
    prompt: "Aus welchem Land stammt Ducati?",
    timeLimitSeconds: 15,
    maxPoints: 1000,
    options: choice(["Italien", "Spanien", "Frankreich"], [0]),
  },
];

async function main(): Promise<void> {
  const repository = createQuizRepository(getDb());
  const { id } = await repository.createQuiz({ title: "Demo Quiz", description: "Beispiel mit allen Fragetypen zum Ausprobieren." });
  for (const question of QUESTIONS) await repository.saveQuestion(id, null, question);
  await repository.setStatus(id, "ready");
  console.log(`Demo Quiz angelegt (Kennung ${id}), Status Bereit, ${QUESTIONS.length} Fragen.`);
  await getPool().end();
}

main().catch((error: unknown) => {
  console.error("Das Demo Quiz konnte nicht angelegt werden:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
