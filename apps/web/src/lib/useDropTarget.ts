import { useRef, useState, type DragEvent } from "react";

/**
 * Cible de glisser-déposer de fichiers : over vaut true pendant le survol (compteur d'entrées, les enfants
 * émettent leurs propres dragenter/dragleave). Ignore ce qui n'est pas un fichier (texte, lien).
 */
export function useDropTarget(onDrop: (dt: DataTransfer) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const handlers = enabled
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          onDrop(e.dataTransfer);
        },
      }
    : {};
  return { over, handlers };
}
