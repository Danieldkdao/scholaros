import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";

const Page = () => (
  <Suspense>
    <AuthForm />
  </Suspense>
);

export default Page;
