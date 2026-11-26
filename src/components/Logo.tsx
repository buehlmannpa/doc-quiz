import Image from "next/image";

/**
 * Wappen des DOC Bern. Die Grösse wird über die Höhe in className gesetzt (zum Beispiel "h-9"),
 * die Breite folgt dem Seitenverhältnis des Bildes (646 mal 692 Pixel).
 */
export default function Logo({ className = "h-9", priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src="/logo.png"
      alt="DOC Bern"
      width={646}
      height={692}
      priority={priority}
      className={`w-auto ${className}`}
    />
  );
}
