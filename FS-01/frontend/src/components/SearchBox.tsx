import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useSuggestions } from "../api/search";

// The header search box: Enter searches, and suggestions appear as you type (arrow keys + Enter, or click).
// Follows the ARIA combobox pattern so screen readers announce the suggestions.
export function SearchBox() {
  const location = useLocation();
  const [params] = useSearchParams();
  // On a results page the box shows that search; a new search (or going back) starts the box afresh.
  const urlQuery = location.pathname === "/search" ? (params.get("q") ?? "") : "";
  return <SearchInput key={urlQuery} initial={urlQuery} />;
}

function SearchInput({ initial }: { initial: string }) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const suggestions = useSuggestions(text);
  const items = open ? (suggestions.data ?? []) : [];

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pick = items[active];
    close();
    if (pick) navigate(`/products/${pick.id}`);
    else if (text.trim()) navigate(`/search?q=${encodeURIComponent(text.trim())}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-md">
      <input
        type="search"
        role="combobox"
        aria-label="Search products"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        placeholder="Search products, brands and stores"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(close, 150)}
        className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-600"
      />
      <ul id={listId} role="listbox" aria-label="Suggestions" className={items.length ? "absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg" : "hidden"}>
        {items.map((s, i) => (
          <li
            key={s.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown, not click: it fires before the input's blur closes the list.
            onMouseDown={(e) => {
              e.preventDefault();
              close();
              navigate(`/products/${s.id}`);
            }}
            className={`cursor-pointer truncate px-3 py-2 text-sm ${i === active ? "bg-brand-50 text-brand-700" : "hover:bg-slate-50"}`}
          >
            {s.title}
          </li>
        ))}
      </ul>
    </form>
  );
}
