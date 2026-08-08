import catalogData from "../../public/catalog/catalog-v1.json";
import { OrderBuilder, type OrderBuilderConfiguration } from "../../components/food/OrderBuilder";
import { LocaleProvider, type Locale, WorkflowShell } from "../../lib/i18n";
import type { OrderItem } from "../../lib/domain";
import {
  getFoodGuardConfiguration,
  getFoodGuardPublicAppOriginConfiguration,
} from "../../lib/genlayer/config";

type PageSearchParams = Promise<{ locale?: string | string[] }>;

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function configurationView(): OrderBuilderConfiguration {
  const configuration = getFoodGuardConfiguration();
  return configuration.status === "READY"
    ? { address: configuration.address, status: "READY", writesEnabled: true }
    : {
        address: null,
        message: configuration.message,
        status: "DEPLOYMENT_REQUIRED",
        writesEnabled: false,
      };
}

export default async function CreateOrderPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const params = await searchParams;
  const rawLocale = firstValue(params.locale);
  const locale: Locale = rawLocale === "en" ? "en" : "vi";
  const item = catalogData.restaurants[0].featured_item as OrderItem;

  return (
    <LocaleProvider hasExplicitLocale={Boolean(rawLocale)} initialLocale={locale}>
      <WorkflowShell page="create">
        <OrderBuilder
          configuration={configurationView()}
          item={item}
          publicAppConfiguration={getFoodGuardPublicAppOriginConfiguration()}
        />
      </WorkflowShell>
    </LocaleProvider>
  );
}
