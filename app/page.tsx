import catalogData from "../public/catalog/catalog-v1.json";
import { CategoryChips, type FoodCategory } from "../components/food/CategoryChips";
import { Hero } from "../components/food/Hero";
import { ProofStrip } from "../components/food/ProofStrip";
import { RestaurantCard } from "../components/food/RestaurantCard";
import type { Restaurant } from "../lib/domain";
import { landingCopy, type LandingLocale } from "../lib/landing-copy";
import {
  getFoodGuardConfiguration,
  type FoodGuardConfiguration,
} from "../lib/genlayer/config";

const categoryDefinitions = [
  { catalogValue: "Cơm Việt", en: "Vietnamese rice", vi: "Cơm Việt", slug: "com-viet" },
  { catalogValue: "Món nước", en: "Noodle soups", vi: "Món nước", slug: "mon-nuoc" },
  { catalogValue: "Món chay", en: "Vegetarian", vi: "Món chay", slug: "mon-chay" },
  { catalogValue: "Cuốn & gỏi", en: "Rolls & salads", vi: "Cuốn & gỏi", slug: "cuon-goi" },
  { catalogValue: "Bánh mì", en: "Banh mi", vi: "Bánh mì", slug: "banh-mi" },
];

const restaurants = catalogData.restaurants as Restaurant[];

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/giu, "d")
    .toLocaleLowerCase("vi")
    .trim();
}

function filterRestaurants(searchQuery: string, categorySlug: string): Restaurant[] {
  const normalizedQuery = normalizeSearch(searchQuery);
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const selectedCategory = categoryDefinitions.find((category) => category.slug === categorySlug);

  return restaurants.filter((restaurant) => {
    const matchesCategory = selectedCategory
      ? restaurant.categories.includes(selectedCategory.catalogValue)
      : true;
    const searchable = normalizeSearch(
      [
        restaurant.name,
        restaurant.description,
        restaurant.neighborhood,
        ...restaurant.categories,
        restaurant.featured_item.name,
        ...restaurant.featured_item.conditions,
      ].join(" "),
    );
    const searchableTerms = searchable.split(/[^a-z0-9]+/).filter(Boolean);
    const matchesQuery = queryTerms.every((queryTerm) =>
      searchableTerms.some(
        (searchableTerm) =>
          searchableTerm === queryTerm ||
          (queryTerm.length >= 4 && searchableTerm.startsWith(queryTerm)),
      ),
    );
    return matchesCategory && matchesQuery;
  });
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 36" width="24" height="27">
        <path d="M16 2 29 7v9c0 8.2-5.1 14.4-13 18C8.1 30.4 3 24.2 3 16V7L16 2Z" fill="currentColor" />
        <path d="m10.2 17.4 3.7 3.7 7.9-8.2" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.7" />
      </svg>
    </span>
  );
}

function localeHref(locale: LandingLocale, searchQuery: string, categorySlug: string): string {
  const params = new URLSearchParams();
  if (searchQuery) params.set("q", searchQuery);
  if (categorySlug) params.set("category", categorySlug);
  if (locale === "en") params.set("locale", "en");
  const query = params.toString();
  return `/${query ? `?${query}` : ""}`;
}

function SiteHeader({ categorySlug, locale, searchQuery }: { categorySlug: string; locale: LandingLocale; searchQuery: string }) {
  const copy = landingCopy[locale];
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="brand" href={localeHref(locale, "", "")} aria-label={copy.home}>
          <BrandMark />
          <span>FoodGuard</span>
        </a>

        <nav className="site-nav" aria-label={copy.mainNavigation}>
          <a href="#nha-hang">{copy.explore}</a>
          <a href="#bang-chung">{copy.howItWorks}</a>
        </nav>

        <nav className="language-ready" aria-label={copy.language}>
          <a aria-current={locale === "vi" ? "page" : undefined} aria-label="Tiếng Việt" href={localeHref("vi", searchQuery, categorySlug)}>VI</a>
          <a aria-current={locale === "en" ? "page" : undefined} aria-label="English" href={localeHref("en", searchQuery, categorySlug)} lang="en">EN</a>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter({ locale }: { locale: LandingLocale }) {
  const copy = landingCopy[locale];
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <a className="brand brand--footer" href={localeHref(locale, "", "")} aria-label={copy.home}>
          <BrandMark />
          <span>FoodGuard</span>
        </a>
        <p>{copy.footer}</p>
        <p>StudioNet · Simulated GEN only</p>
      </div>
    </footer>
  );
}

interface LandingPageProps {
  categorySlug?: string;
  configuration: FoodGuardConfiguration;
  locale?: LandingLocale;
  searchQuery?: string;
}

export function LandingPage({
  categorySlug = "",
  configuration,
  locale = "vi",
  searchQuery = "",
}: LandingPageProps) {
  const copy = landingCopy[locale];
  const categories: FoodCategory[] = categoryDefinitions.map((category) => ({
    catalogValue: category.catalogValue,
    label: category[locale],
    slug: category.slug,
  }));
  const selectedCategory = categories.find((category) => category.slug === categorySlug);
  const visibleRestaurants = filterRestaurants(searchQuery, categorySlug);
  const hasFilters = Boolean(searchQuery.trim() || selectedCategory);

  return (
    <div className="page-shell" lang={locale}>
      <a className="skip-link" href="#main-content">{copy.skip}</a>
      <SiteHeader categorySlug={categorySlug} locale={locale} searchQuery={searchQuery} />
      <main id="main-content">
        <Hero
          contractReady={configuration.status === "READY"}
          categorySlug={categorySlug}
          locale={locale}
          resultCount={visibleRestaurants.length}
          searchQuery={searchQuery}
        />

        <div id="bang-chung" className="section-wrap section-wrap--proof">
          <ProofStrip locale={locale} />
        </div>

        <section className="restaurant-section" id="nha-hang" aria-labelledby="restaurants-title">
          <div className="restaurant-section__heading">
            <div>
              <p className="eyebrow">{copy.catalogEyebrow}</p>
              <h2 id="restaurants-title">{copy.catalogTitle}</h2>
            </div>
            <p aria-live="polite">
              {hasFilters
                ? locale === "en"
                  ? `${visibleRestaurants.length} restaurant${visibleRestaurants.length === 1 ? "" : "s"} match the current filters.`
                  : `${visibleRestaurants.length} nhà hàng phù hợp với bộ lọc hiện tại.`
                : copy.defaultResults}
            </p>
          </div>

          <CategoryChips
            activeSlug={selectedCategory?.slug}
            categories={categories}
            locale={locale}
            searchQuery={searchQuery}
          />

          <div className="restaurant-grid" aria-label={copy.results}>
            {visibleRestaurants.map((restaurant, index) => (
              <RestaurantCard
                eager={hasFilters && index === 0}
                locale={locale}
                restaurant={restaurant}
                key={restaurant.restaurant_id}
              />
            ))}
          </div>
          {visibleRestaurants.length === 0 && (
            <div className="empty-results" role="status">
              <h3>{copy.emptyTitle}</h3>
              <p>{copy.emptyBody}</p>
            </div>
          )}
        </section>

        <section className="closing-note" aria-labelledby="closing-title">
          <p className="eyebrow eyebrow--light">{copy.closingEyebrow}</p>
          <div className="closing-note__body">
            <h2 id="closing-title">{copy.closingTitle}</h2>
            <p>{copy.closingBody}</p>
          </div>
        </section>
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}

type PageSearchParams = Promise<{
  category?: string | string[];
  locale?: string | string[];
  q?: string | string[];
}>;

function firstSearchValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function HomePage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  return (
    <LandingPage
      categorySlug={firstSearchValue(params.category)}
      configuration={getFoodGuardConfiguration()}
      locale={firstSearchValue(params.locale) === "en" ? "en" : "vi"}
      searchQuery={firstSearchValue(params.q)}
    />
  );
}
