import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { LoginMethod } from "../shared/model";

export function initialLoginMethod(
  layout: PluginSurfaceProps["layout"],
  browserSignIn: boolean | undefined,
): LoginMethod {
  // Browser callbacks return to the daemon host. Native and compact clients use a code,
  // including phone browsers whose platform is "web". The browser option stays available.
  if (browserSignIn === false || layout.compact || layout.platform !== "web") return "code";
  return "browser";
}
