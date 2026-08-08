import Image from "next/image";

import type { Restaurant } from "../../lib/domain";
import type { LandingLocale } from "../../lib/landing-copy";

interface RestaurantCardProps {
  eager?: boolean;
  locale: LandingLocale;
  restaurant: Restaurant;
}

const WEI_PER_GEN = 1_000_000_000_000_000_000n;

export function formatSimulatedGen(priceWei: string, locale: LandingLocale = "vi"): string {
  const value = BigInt(priceWei);
  const whole = value / WEI_PER_GEN;
  const fraction = (value % WEI_PER_GEN)
    .toString()
    .padStart(18, "0")
    .slice(0, 2)
    .replace(/0+$/, "");

  return fraction ? `${whole}${locale === "en" ? "." : ","}${fraction}` : whole.toString();
}

export function RestaurantCard({ eager = false, locale, restaurant }: RestaurantCardProps) {
  const titleId = `restaurant-${restaurant.restaurant_id}`;

  return (
    <article className="restaurant-card" aria-labelledby={titleId}>
      <div className="restaurant-card__image">
        <Image
          src={restaurant.image_src}
          alt={restaurant.image_alt}
          fill
          loading={eager ? "eager" : "lazy"}
          sizes="(max-width: 639px) calc(100vw - 40px), (max-width: 1023px) 46vw, 30vw"
        />
        <span className="restaurant-card__proof">
          <span aria-hidden="true">✓</span>
          {locale === "en" ? "Versioned catalog" : "Catalog có phiên bản"}
        </span>
      </div>

      <div className="restaurant-card__body">
        <div className="restaurant-card__meta">
          <span>{restaurant.neighborhood}</span>
          <span aria-hidden="true">•</span>
          <span>
            {restaurant.delivery_time_minutes[0]}–{restaurant.delivery_time_minutes[1]} {locale === "en" ? "min" : "phút"}
          </span>
        </div>
        <h3 id={titleId}>{restaurant.name}</h3>
        <p>{restaurant.description}</p>

        <div className="restaurant-card__footer">
          <div>
            <span className="restaurant-card__item-label">{locale === "en" ? "Featured dish" : "Món nổi bật"}</span>
            <strong>{restaurant.featured_item.name}</strong>
          </div>
          <span className="restaurant-card__price">
            {locale === "en" ? "From" : "Từ"} {formatSimulatedGen(restaurant.featured_item.price_wei, locale)} Simulated GEN
          </span>
        </div>
      </div>
    </article>
  );
}
