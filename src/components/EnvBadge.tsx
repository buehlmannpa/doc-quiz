import { resolveDeploymentEnv } from "@/lib/env";

/**
 * Gelber Streifen und Pille ausserhalb der Produktion (wie in der Club App).
 * So ist ein Preview Deployment nie mit dem echten Quiz zu verwechseln.
 */
export default function EnvBadge() {
  const env = resolveDeploymentEnv(process.env);
  if (env === "production") return null;

  const label = env === "preview" ? "PREVIEW" : env === "development" ? "DEVELOPMENT" : "LOKAL";
  const branch = process.env.VERCEL_GIT_COMMIT_REF;

  return (
    <div aria-hidden="true" className="pointer-events-none select-none">
      <div className="fixed inset-x-0 top-0 z-[100] h-1.5 bg-amber-400" />
      <div className="fixed right-3 bottom-3 z-[100]">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 text-[11px] font-bold tracking-wide text-black uppercase shadow-lg ring-1 ring-black/10">
          {label}
          {branch ? <span className="font-medium normal-case opacity-80">{branch}</span> : null}
        </span>
      </div>
    </div>
  );
}
