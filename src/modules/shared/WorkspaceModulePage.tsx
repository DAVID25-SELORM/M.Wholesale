import { useParams } from 'react-router-dom'
import { Card, CardBody, PageHeader } from '@/components/ui'

export function WorkspaceModulePage() {
  const { module = '' } = useParams()
  const title = module.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  return <div className="min-w-0">
    <PageHeader title={title} />
    <Card><CardBody><p role="status">This workflow is still under development. Record creation and saving are not available yet.</p></CardBody></Card>
  </div>
}
