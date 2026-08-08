import Image from "next/image";
import { landingCopy, type LandingLocale } from "../../lib/landing-copy";

interface HeroProps {
  contractReady: boolean;
  categorySlug?: string;
  locale: LandingLocale;
  resultCount: number;
  searchQuery?: string;
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

export function Hero({ categorySlug = "", contractReady, locale, resultCount, searchQuery = "" }: HeroProps) {
  const copy = landingCopy[locale];
  const resultLabel = locale === "en"
    ? `Explore ${resultCount} restaurant${resultCount === 1 ? "" : "s"}`
    : `Khám phá ${resultCount} nhà hàng`;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__media">
        <Image
          src="/images/foodguard/hero-marketplace.webp"
          alt={copy.heroAlt}
          fill
          priority
          sizes="(max-width: 767px) 100vw, (max-width: 1439px) 94vw, 1320px"
        />
      </div>
      <div className="hero__veil" aria-hidden="true" />

      <div className="hero__content">
        <div className="network-badge">
          <span className="network-badge__mark" aria-hidden="true">S</span>
          <span>StudioNet · Simulated GEN</span>
        </div>

        <p className="eyebrow">{copy.heroEyebrow}</p>
        <h1 id="hero-title">{copy.heroTitle}</h1>
        <p className="hero__lede">{copy.heroLede}</p>

        <form className="hero-search" role="search" action="/#nha-hang">
          <label className="sr-only" htmlFor="marketplace-search">
            {copy.searchLabel}
          </label>
          <span className="hero-search__icon"><SearchIcon /></span>
          <input
            id="marketplace-search"
            name="q"
            type="search"
            defaultValue={searchQuery}
            placeholder={copy.searchPlaceholder}
          />
          {locale === "en" && <input type="hidden" name="locale" value="en" />}
          {categorySlug && <input type="hidden" name="category" value={categorySlug} />}
          <button type="submit">{copy.searchButton}</button>
        </form>

        <div className="hero__actions">
          <a className="button button--primary" href="#nha-hang">
            {resultLabel}
            <span aria-hidden="true">↓</span>
          </a>
          {contractReady ? (
            <a className="button button--quiet" href="/create">
              {copy.createOrder}
            </a>
          ) : (
            <button className="button button--quiet" type="button" disabled>
              {copy.createOrder}
            </button>
          )}
        </div>

        {!contractReady && (
          <div className="deployment-note" role="status">
            <strong>DEPLOYMENT_REQUIRED</strong>
            <span>{copy.deployment}</span>
          </div>
        )}
      </div>
    </section>
  );
}
