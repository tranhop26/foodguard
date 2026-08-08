import { landingCopy, type LandingLocale } from "../../lib/landing-copy";

export interface FoodCategory {
  catalogValue: string;
  label: string;
  slug: string;
}

interface CategoryChipsProps {
  activeSlug?: string;
  categories: FoodCategory[];
  locale: LandingLocale;
  searchQuery?: string;
}

function categoryHref(slug: string | undefined, searchQuery: string, locale: LandingLocale): string {
  const params = new URLSearchParams();
  if (searchQuery) params.set("q", searchQuery);
  if (slug) params.set("category", slug);
  if (locale === "en") params.set("locale", "en");
  const query = params.toString();
  return `/${query ? `?${query}` : ""}#nha-hang`;
}

export function CategoryChips({
  activeSlug,
  categories,
  locale,
  searchQuery = "",
}: CategoryChipsProps) {
  const copy = landingCopy[locale];
  return (
    <nav className="category-nav" aria-label={copy.categories}>
      <a
        className={`category-chip${activeSlug ? "" : " category-chip--active"}`}
        href={categoryHref(undefined, searchQuery, locale)}
        aria-current={activeSlug ? undefined : "page"}
      >
        {copy.all}
      </a>
      {categories.map((category) => (
        <a
          aria-current={activeSlug === category.slug ? "page" : undefined}
          className={`category-chip${activeSlug === category.slug ? " category-chip--active" : ""}`}
          href={categoryHref(category.slug, searchQuery, locale)}
          key={category.slug}
        >
          {category.label}
        </a>
      ))}
    </nav>
  );
}
