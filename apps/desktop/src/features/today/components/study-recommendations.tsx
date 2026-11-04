import { ArrowUpRight, Sparkles } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@scholaros/ui/components/item';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import type { Recommendation } from '@scholaros/services/learning/today-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import { formatStudyActivity, formatTodayItemSource } from '../lib/formatters';

type StudyRecommendationsProps = {
  recommendations: Recommendation[];
  onStart: (recommendation?: Recommendation) => void;
  onOpenSource: (reference: SourceReference) => void | Promise<void>;
};

export const StudyRecommendations = ({
  recommendations,
  onStart,
  onOpenSource,
}: StudyRecommendationsProps) => (
  <Card>
    <CardHeader>
      <CardTitle>What to study next</CardTitle>
    </CardHeader>
    <CardContent>
      {recommendations.length ? (
        <ItemGroup>
          {recommendations.map((recommendation) => {
            const { Icon, label } = formatStudyActivity(
              recommendation.activity,
            );
            const sourceReference = recommendation.sourceReferences[0];
            const sourceLabel = sourceReference
              ? formatTodayItemSource(sourceReference.sourceKind)
              : 'View course source';
            return (
              <Item
                key={recommendation.id}
                variant="outline"
                role="listitem"
                className="text-base"
              >
                <ItemMedia variant="icon">
                  <Icon
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-base">{label}</ItemTitle>
                  <p className="text-base text-muted-foreground">
                    {recommendation.reason}
                  </p>
                </ItemContent>
                <ItemActions>
                  {sourceReference && (
                    <TooltipWrapper content={sourceLabel}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={sourceLabel}
                        onClick={() => void onOpenSource(sourceReference)}
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                    </TooltipWrapper>
                  )}
                  <Button onClick={() => onStart(recommendation)}>
                    {label}
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      ) : (
        <Empty className="border-0 p-4">
          <EmptyHeader>
            <EmptyMedia />
            <EmptyTitle>No next-study recommendation yet</EmptyTitle>
            <EmptyDescription className="text-base">
              Connect a class or add study evidence to get a source-backed
              suggestion.
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => onStart()}>
            <Sparkles aria-hidden="true" />
            Start a study session
          </Button>
        </Empty>
      )}
    </CardContent>
  </Card>
);
