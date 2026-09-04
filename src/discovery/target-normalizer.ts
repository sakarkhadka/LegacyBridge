import type { LocatorStrategy, TargetDescriptor } from "../artifact/types.js";

export function normalizeTarget(target: TargetDescriptor | undefined): TargetDescriptor | undefined {
  if (!target) {
    return undefined;
  }

  const fallbacks = (target.fallbacks ?? [])
    .map(normalizeLocator)
    .filter((locator) => locator.strategy !== "coordinates" || target.primary.strategy === "coordinates");

  return pruneUndefined({
    id: target.id,
    description: target.description,
    primary: normalizeLocator(target.primary),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  });
}

function normalizeLocator(locator: LocatorStrategy): LocatorStrategy {
  if (locator.strategy === "frame") {
    return pruneUndefined({
      ...locator,
      child: normalizeLocator(locator.child)
    });
  }

  if (locator.strategy === "structural") {
    return pruneUndefined({
      ...locator,
      containerText: locator.containerText?.trim() || undefined,
      rowText: locator.rowText?.trim() || undefined,
      columnText: locator.columnText?.trim() || undefined
    });
  }

  return locator;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
