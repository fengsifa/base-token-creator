import "react";

declare module "react" {
  interface CSSProperties {
    WebkitTextSecurity?: string;
  }
}
