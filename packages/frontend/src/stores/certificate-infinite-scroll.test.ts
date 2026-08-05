import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useCertificatesStore } from "@/stores/certificates";
import { useSSLStore } from "@/stores/ssl";
import type { Certificate, SSLCertificate } from "@/types";

const pkiCertificate = (id: string) => ({ id, commonName: id }) as Certificate;
const sslCertificate = (id: string) => ({ id, name: id }) as SSLCertificate;

describe("certificate infinite scroll stores", () => {
  beforeEach(() => {
    useCertificatesStore.setState({
      certificates: [],
      isLoading: false,
      isLoadingMore: false,
      filters: { search: "", status: "active", type: "all", caId: "all" },
      total: 0,
      hasMore: false,
      nextPage: 1,
    });
    useSSLStore.setState({
      certificates: [],
      isLoading: false,
      isLoadingMore: false,
      filters: { search: "", type: "all", status: "active" },
      total: 0,
      hasMore: false,
      nextPage: 1,
    });
  });

  it("appends the next PKI certificate page and stops at the final page", async () => {
    const listCertificates = vi
      .spyOn(api, "listCertificates")
      .mockResolvedValueOnce({
        data: [pkiCertificate("cert-1")],
        pagination: { page: 1, limit: 25, total: 2, totalPages: 2 },
      })
      .mockResolvedValueOnce({
        data: [pkiCertificate("cert-2")],
        pagination: { page: 2, limit: 25, total: 2, totalPages: 2 },
      });

    await useCertificatesStore.getState().fetchCertificates();
    await useCertificatesStore.getState().fetchNextPage();

    expect(listCertificates.mock.calls.map(([params]) => params?.page)).toEqual([1, 2]);
    expect(useCertificatesStore.getState()).toMatchObject({
      certificates: [pkiCertificate("cert-1"), pkiCertificate("cert-2")],
      hasMore: false,
      nextPage: 3,
    });
  });

  it("appends the next SSL certificate page and stops at the final page", async () => {
    const listCertificates = vi
      .spyOn(api, "listSSLCertificates")
      .mockResolvedValueOnce({
        data: [sslCertificate("ssl-1")],
        pagination: { page: 1, limit: 25, total: 2, totalPages: 2 },
      })
      .mockResolvedValueOnce({
        data: [sslCertificate("ssl-2")],
        pagination: { page: 2, limit: 25, total: 2, totalPages: 2 },
      });

    await useSSLStore.getState().fetchCertificates();
    await useSSLStore.getState().fetchNextPage();

    expect(listCertificates.mock.calls.map(([params]) => params?.page)).toEqual([1, 2]);
    expect(useSSLStore.getState()).toMatchObject({
      certificates: [sslCertificate("ssl-1"), sslCertificate("ssl-2")],
      hasMore: false,
      nextPage: 3,
    });
  });
});
