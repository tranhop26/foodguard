"use client";

import {
  createContext,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import en from "../locales/en";
import vi from "../locales/vi";

export type Locale = "vi" | "en";
export type FoodGuardCopy = typeof vi | typeof en;

export const LOCALE_STORAGE_KEY = "foodguard.locale";

const dictionaries: Record<Locale, FoodGuardCopy> = { en, vi };

interface LocaleContextValue {
  copy: FoodGuardCopy;
  locale: Locale;
  setLocale(locale: Locale): void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function localeUrl(locale: Locale): string {
  const url = new URL(window.location.href);
  if (locale === "en") url.searchParams.set("locale", "en");
  else url.searchParams.delete("locale");
  return `${url.pathname}${url.search}${url.hash}`;
}

function persistLocale(locale: Locale): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

export function LocaleProvider({
  children,
  hasExplicitLocale = false,
  initialLocale = "vi",
}: {
  children: ReactNode;
  hasExplicitLocale?: boolean;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    persistLocale(nextLocale);
    window.history.replaceState(window.history.state, "", localeUrl(nextLocale));
  }, []);

  useEffect(() => {
    if (hasExplicitLocale) {
      persistLocale(initialLocale);
      return;
    }
    const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (storedLocale === "en" || storedLocale === "vi") {
      setLocaleState(storedLocale);
      window.history.replaceState(window.history.state, "", localeUrl(storedLocale));
    }
  }, [hasExplicitLocale, initialLocale]);

  const value = useMemo(
    () => ({ copy: dictionaries[locale], locale, setLocale }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used inside LocaleProvider");
  return context;
}

export function LocaleSwitcher() {
  const { copy, locale, setLocale } = useLocale();
  return (
    <nav className="language-ready" aria-label={copy.common.language}>
      <button
        aria-pressed={locale === "vi"}
        onClick={() => setLocale("vi")}
        type="button"
      >
        {copy.common.vietnamese}
      </button>
      <button
        aria-pressed={locale === "en"}
        lang="en"
        onClick={() => setLocale("en")}
        type="button"
      >
        {copy.common.english}
      </button>
    </nav>
  );
}

export function LocalePreferenceLink({
  children,
  className,
  href,
  locale,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  href: string;
  locale: Locale;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      persistLocale(locale);
    }
  }

  return (
    <a className={className} href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

export function WorkflowShell({
  children,
  page,
}: {
  children: ReactNode;
  page: "create" | "orders";
}) {
  const { copy, locale } = useLocale();
  const homeHref = locale === "en" ? "/?locale=en" : "/";

  return (
    <div className="workflow-page" lang={locale}>
      <header className="workflow-header">
        <a aria-label="FoodGuard" className="brand" href={homeHref}>FoodGuard</a>
        <LocaleSwitcher />
      </header>
      <main className="workflow-main">
        <a className="workflow-back" href={homeHref}>← {copy.pages.back}</a>
        {page === "orders" && (
          <section className="workflow-intro" aria-labelledby="orders-title">
            <p className="eyebrow">StudioNet · Simulated GEN</p>
            <h1 id="orders-title">{copy.pages.ordersTitle}</h1>
            <p>{copy.pages.orderLookup}</p>
          </section>
        )}
        {children}
      </main>
    </div>
  );
}
