import React from "react";
import { Layout, LayoutProps } from "react-admin";
import { ReactQueryDevtools } from "react-query/devtools";

export function CustomLayout(props: LayoutProps) {
  return (
    <>
      <Layout {...props} />
      <ReactQueryDevtools initialIsOpen={false} />
    </>
  );
}
