import * as React from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export function PageHeader({
  crumbs,
  title,
  description,
  action,
}: {
  crumbs: string[];
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-heading">
      <div className="min-w-0">
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <React.Fragment key={`${crumb}-${index}`}>
                {index ? <BreadcrumbSeparator /> : null}
                <BreadcrumbItem><BreadcrumbPage>{crumb}</BreadcrumbPage></BreadcrumbItem>
              </React.Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-primary-action">{action}</div> : null}
    </header>
  );
}
