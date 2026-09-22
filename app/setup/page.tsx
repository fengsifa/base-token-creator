import { FactorySetup } from "../../components/factory-setup";

export const metadata = {
  title: "Deploy the Token Factory · Tokenbase",
  description: "One-time deployment of the ownerless Token Factory contract.",
};

export default function SetupPage() {
  return <FactorySetup />;
}
