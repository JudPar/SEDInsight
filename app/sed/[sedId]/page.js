import GeopluzPage from '@/app/page';

export default async function SedRoutePage({ params }) {
  const { sedId = '' } = await params;
  return <GeopluzPage requestedSedId={sedId} isSedRoute />;
}
