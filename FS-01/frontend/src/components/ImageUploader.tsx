import { useId, useState, type ChangeEvent } from "react";
import { ApiError } from "../api/client";
import { IMAGE_TYPES, imageProblem, uploadImage, type UploadPurpose } from "../api/uploads";

export interface UploadedImage {
  key: string;
  url: string;
  alt: string;
}

const messageOf = (err: unknown) => (err instanceof ApiError ? (Object.values(err.fieldErrors)[0] ?? err.message) : (err as Error).message);

// Pick photos → each one is checked here, then uploaded straight to S3 with a link the API signs for that file.
// The first photo is the cover shown in lists.
export function ImageUploader({
  images,
  onChange,
  max,
  purpose = "product-image",
  error,
}: {
  images: UploadedImage[];
  onChange: (images: UploadedImage[]) => void;
  max: number;
  purpose?: UploadPurpose;
  error?: string;
}) {
  const inputId = useId();
  const [uploading, setUploading] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const room = max - images.length;
    const errors: string[] = [];
    if (files.length > room) errors.push(`You can add ${room} more ${room === 1 ? "photo" : "photos"} (up to ${max}).`);
    const accepted = files.slice(0, Math.max(0, room)).filter((f) => {
      const problem = imageProblem(f);
      if (problem) errors.push(problem);
      return !problem;
    });
    setProblems(errors);
    setUploading(accepted.map((f) => f.name));

    // One at a time, each added as soon as it's done, so a slow or failed file doesn't hold up the others.
    let current = images;
    for (const file of accepted) {
      try {
        const { key, url } = await uploadImage(file, purpose);
        current = [...current, { key, url, alt: "" }];
        onChange(current);
      } catch (err) {
        setProblems((p) => [...p, `${file.name}: ${messageOf(err)}`]);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  };

  const move = (from: number, to: number) => {
    const next = [...images];
    const [img] = next.splice(from, 1);
    next.splice(to, 0, img!);
    onChange(next);
  };

  return (
    <div>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6" aria-label="Photos">
        {images.map((img, i) => (
          <li key={img.key} className="relative overflow-hidden rounded-lg border border-slate-200 bg-white">
            <img src={img.url} alt={img.alt || `Photo ${i + 1}`} className="aspect-square w-full object-contain p-1" />
            {i === 0 && max > 1 && <span className="absolute left-1 top-1 rounded bg-brand-600 px-1.5 text-[10px] font-medium text-white">Cover</span>}
            <div className="flex justify-between border-t border-slate-100 text-xs">
              {i > 0 ? (
                <button type="button" onClick={() => move(i, 0)} className="px-2 py-1 text-brand-700 hover:underline" aria-label={`Make photo ${i + 1} the cover`}>
                  Cover
                </button>
              ) : (
                <span />
              )}
              <button type="button" onClick={() => onChange(images.filter((_, j) => j !== i))} className="px-2 py-1 text-red-700 hover:underline" aria-label={`Remove photo ${i + 1}`}>
                Remove
              </button>
            </div>
          </li>
        ))}
        {uploading.map((name) => (
          <li key={name} className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-slate-300 p-2 text-center text-xs text-slate-500">
            Uploading {name}…
          </li>
        ))}
        {images.length + uploading.length < max && (
          <li>
            <label
              htmlFor={inputId}
              className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 text-center text-xs text-slate-500 hover:border-brand-600 hover:text-brand-700"
            >
              <span className="text-2xl" aria-hidden="true">
                +
              </span>
              Add {max > 1 ? "photos" : "photo"}
            </label>
            <input id={inputId} type="file" accept={IMAGE_TYPES.join(",")} multiple={max > 1} onChange={pick} className="sr-only" />
          </li>
        )}
      </ul>
      <p className="mt-2 text-xs text-slate-500">JPEG, PNG or WebP, up to 5 MB each.</p>
      {[...problems, ...(error ? [error] : [])].map((p) => (
        <p key={p} role="alert" className="mt-1 text-xs text-red-700">
          {p}
        </p>
      ))}
    </div>
  );
}
